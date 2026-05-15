"""FastAPI chat API: portfolio-grounded LangChain backends."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field, field_validator

from app.gemini_routing import GeminiRoutingChain
from app.knowledge_context import (
    build_context,
    build_live_system_instruction,
    compact_history,
    default_pack_dir,
    default_system_prompt_path,
    load_knowledge_pack,
    load_system_prompt,
)
from app.live_env import live_model_id
from app.live_relay import relay_browser_to_google
from app.providers import (
    build_llm_runnable,
    get_provider_and_model,
    get_provider_timeout_seconds,
)
from app.transcript_store import build_transcript_store
from app.upstream_errors import upstream_error_body

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def _live_relay_enabled() -> bool:
    return os.environ.get("CHAT_LIVE_RELAY", "1").strip().lower() not in ("0", "false", "no", "")


def _live_voice_strict_enabled() -> bool:
    return os.environ.get("CHAT_LIVE_VOICE_STRICT", "0").strip().lower() in ("1", "true", "yes")


async def mint_live_session_async(system_instruction: str) -> Any:
    """Delegate to live_gemini so importing app.main avoids google-genai unless live is used."""
    from app import live_gemini as _lg

    return await _lg.mint_live_session_async(system_instruction)


def google_constrained_browser_ws_url(token_name: str) -> str:
    from app import live_gemini as _lg

    return _lg.google_constrained_browser_ws_url(token_name)


MAX_MESSAGES = int(os.environ.get("CHAT_MAX_MESSAGES", "32"))
MAX_CONTENT_LEN = int(os.environ.get("CHAT_MAX_CONTENT_LEN", "8000"))


def _cors_expand_apex_www(origins: list[str]) -> list[str]:
    """Add www <-> apex variants for bare hosts (example.com).

    Also adds https://chat.apex for each two-label https apex (e.g. marwanelgendy.link) so
    WebSocket relay Origin checks match the chat UI subdomain without duplicating every URL in env.
    """
    seen: set[str] = set()
    out: list[str] = []
    for o in origins:
        o = o.strip()
        if not o or o in seen:
            continue
        seen.add(o)
        out.append(o)

    additions: list[str] = []
    for o in out:
        try:
            p = urlparse(o)
        except ValueError:
            continue
        if p.scheme not in ('http', 'https') or not p.hostname:
            continue
        host_l = p.hostname.lower()
        parts = host_l.split('.')
        if len(parts) == 2 and parts[0] != 'www':
            www_netloc = f'www.{p.hostname}'
            alt = f'{p.scheme}://{www_netloc}'
            if p.port:
                alt = f'{p.scheme}://{www_netloc}:{p.port}'
            additions.append(alt)
        elif len(parts) == 3 and parts[0] == 'www':
            apex_host = '.'.join(parts[1:])
            alt = f'{p.scheme}://{apex_host}'
            if p.port:
                alt = f'{p.scheme}://{apex_host}:{p.port}'
            additions.append(alt)

    for a in additions:
        if a not in seen:
            seen.add(a)
            out.append(a)

    chat_additions: list[str] = []
    for o in list(out):
        try:
            p = urlparse(o)
        except ValueError:
            continue
        if p.scheme != 'https' or not p.hostname:
            continue
        host_l = p.hostname.lower()
        parts = host_l.split('.')
        if len(parts) == 2 and parts[0] != 'www' and parts[0] != 'chat':
            chat_host = f'chat.{host_l}'
            alt = f'https://{chat_host}'
            if p.port:
                alt = f'https://{chat_host}:{p.port}'
            chat_additions.append(alt)

    for a in chat_additions:
        if a not in seen:
            seen.add(a)
            out.append(a)
    return out


def _cors_allow_origins() -> list[str]:
    raw = os.environ.get('CHAT_CORS_ORIGINS', '').strip()
    if not raw:
        return []
    base = [o.strip() for o in raw.split(',') if o.strip()]
    return _cors_expand_apex_www(base)


class ChatMessageIn(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(default="", max_length=MAX_CONTENT_LEN + 1)

    @field_validator("content", mode="before")
    @classmethod
    def truncate_content(cls, v: Any) -> str:
        if v is None:
            return ""
        s = str(v)
        if len(s) > MAX_CONTENT_LEN:
            logger.warning(
                "Truncating message content from %s to %s chars",
                len(s),
                MAX_CONTENT_LEN,
            )
            return s[:MAX_CONTENT_LEN]
        return s


class ChatRequest(BaseModel):
    messages: list[ChatMessageIn] = Field(default_factory=list)
    stream: bool = False
    sessionId: str | None = None


class LiveSessionRequest(BaseModel):
    sessionId: str | None = Field(default=None, max_length=128)


class LiveTranscriptTurn(BaseModel):
    sessionId: str | None = Field(default=None, max_length=128)
    userText: str = Field(default="", max_length=8000)
    assistantText: str = Field(default="", max_length=16000)
    capturedAt: str | None = Field(default=None, max_length=64)
    transport: str | None = Field(default=None, max_length=32)
    toolCalls: list[dict[str, Any]] | None = Field(default=None)


def _live_relay_bridge_ttl_sec() -> float:
    raw = os.environ.get('CHAT_LIVE_RELAY_BRIDGE_TTL_SEC', '300').strip()
    try:
        return max(60.0, min(float(raw), 900.0))
    except ValueError:
        return 300.0


def _cleanup_expired_live_relays(bridges: dict[str, Any]) -> None:
    now = time.monotonic()
    dead = [k for k, v in bridges.items() if float(v.get('expires', 0)) < now]
    for k in dead:
        bridges.pop(k, None)


def _live_relay_ws_url(request: Request, bridge_id: str) -> str:
    proto = (request.headers.get('x-forwarded-proto') or request.url.scheme or 'http').split(',')[0].strip()
    scheme = 'wss' if proto == 'https' else 'ws'
    host = (request.headers.get('x-forwarded-host') or request.headers.get('host') or '').split(',')[0].strip()
    if not host:
        host = request.url.netloc or request.url.hostname or ''
    return f'{scheme}://{host}/api/live/relay/{bridge_id}'


def _live_relay_origin_allowed(websocket: WebSocket) -> bool:
    allowed = _cors_allow_origins()
    if not allowed:
        return True
    origin = (websocket.headers.get('origin') or '').strip()
    if not origin:
        return True
    return origin in allowed


def _to_lc_messages(rows: list[ChatMessageIn]) -> list[HumanMessage | AIMessage | SystemMessage]:
    out: list[HumanMessage | AIMessage | SystemMessage] = []
    for row in rows:
        if row.role == "user":
            out.append(HumanMessage(content=row.content))
        elif row.role == "assistant":
            out.append(AIMessage(content=row.content))
        else:
            out.append(SystemMessage(content=row.content))
    return out


def _reply_text_from_result(result: Any) -> str:
    if not isinstance(result, AIMessage):
        return str(result)
    content = result.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        lines: list[str] = []
        for part in content:
            if isinstance(part, str):
                lines.append(part)
                continue
            if isinstance(part, dict) and isinstance(part.get('text'), str):
                lines.append(part['text'])
        return '\n'.join(line for line in lines if line).strip()
    return str(content)


def _normalize_tool_args(args: Any) -> dict[str, Any]:
    if isinstance(args, dict):
        return args
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _actions_from_result(result: Any) -> list[dict[str, Any]]:
    if not isinstance(result, AIMessage):
        return []
    actions: list[dict[str, Any]] = []
    for call in getattr(result, 'tool_calls', []) or []:
        name = str(call.get('name', '')).strip()
        args = _normalize_tool_args(call.get('args'))
        if name == 'open_resume':
            actions.append({'id': 'open-resume', 'label': 'Open resume'})
            continue
        if name == 'open_contact_form':
            action: dict[str, Any] = {'id': 'open-contact', 'label': 'Open contact form'}
            subject = args.get('subject')
            message = args.get('message')
            prefill: dict[str, str] = {}
            if isinstance(subject, str) and subject.strip():
                prefill['subject'] = subject.strip()
            if isinstance(message, str) and message.strip():
                prefill['message'] = message.strip()
            if prefill:
                action['prefill'] = prefill
            actions.append(action)
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for action in actions:
        aid = str(action.get('id', ''))
        if aid in seen_ids:
            continue
        seen_ids.add(aid)
        deduped.append(action)
    return deduped


def _tool_calls_from_result(result: Any) -> list[dict[str, Any]]:
    if not isinstance(result, AIMessage):
        return []
    calls: list[dict[str, Any]] = []
    for call in getattr(result, 'tool_calls', []) or []:
        calls.append(
            {
                'name': str(call.get('name', '')).strip(),
                'args': _normalize_tool_args(call.get('args')),
                'id': str(call.get('id', '')).strip() or None,
            }
        )
    return calls


def _get_retrieval_snapshot(messages: list[HumanMessage | AIMessage | SystemMessage]) -> dict[str, Any]:
    if app.state.knowledge_pack is None:
        return {
            'tags': [],
            'faq_id': None,
            'faq_question': None,
            'role_ids': [],
            'project_ids': [],
        }
    compacted = compact_history(messages)
    last_user = ''
    for msg in reversed(compacted):
        if getattr(msg, 'type', None) == 'human':
            last_user = str(getattr(msg, 'content', ''))
            break
    history_text = ' '.join(str(getattr(m, 'content', ''))[:300] for m in compacted[-6:])
    context = build_context(last_user, history_text, app.state.knowledge_pack)
    faq_match = context.get('faq_match') or {}
    question = None
    if isinstance(faq_match.get('q'), list) and faq_match.get('q'):
        question = str(faq_match.get('q')[0]).strip() or None
    return {
        'tags': context.get('tags') or [],
        'faq_id': faq_match.get('id'),
        'faq_question': question,
        'role_ids': [str(role.get('id', '')) for role in context.get('roles') or [] if role.get('id')],
        'project_ids': [
            str(project.get('id', ''))
            for project in context.get('projects') or []
            if project.get('id')
        ],
        'retrieval_fallback': bool(context.get('retrieval_fallback')),
    }


def _build_flags(
    messages: list[ChatMessageIn],
    reply_text: str,
    retrieval: dict[str, Any],
    actions: list[dict[str, Any]],
) -> dict[str, bool]:
    last_user = ''
    for row in reversed(messages):
        if row.role == 'user':
            last_user = row.content.lower()
            break
    reply_lower = reply_text.lower()
    negative_tokens = (
        'not helpful',
        'didn',
        'wrong',
        'bad answer',
        'that is incorrect',
        'hallucinat',
    )
    refusal_tokens = (
        "i can't",
        'i cannot',
        "i'm unable",
        'i am unable',
        'not able to',
        "don't have enough",
    )
    # Spec: tag retrieval fell back to defaults (not FAQ-driven context).
    no_retrieval_match = bool(retrieval.get('retrieval_fallback')) and not (
        retrieval.get('faq_id') or retrieval.get('faq_question')
    )
    return {
        'no_retrieval_match': bool(no_retrieval_match),
        'negative_feedback': any(token in last_user for token in negative_tokens),
        'possible_refusal': any(token in reply_lower for token in refusal_tokens),
        'long_conversation': len(messages) >= 12,
        'tool_offered_not_taken': len(actions) > 0,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    pack_dir = default_pack_dir()
    prompt_path = default_system_prompt_path()
    logger.info("Loading knowledge pack from %s", pack_dir)
    app.state.pack_path = str(pack_dir)
    app.state.prompt_path = str(prompt_path)
    app.state.corpus_error = None
    app.state.transcript_store = build_transcript_store()
    app.state.live_relay_bridges = {}
    try:
        pack = load_knowledge_pack(pack_dir)
        prompt_text, prompt_version = load_system_prompt(prompt_path)
    except Exception as exc:
        app.state.knowledge_pack = None
        app.state.system_prompt = ''
        app.state.prompt_version = 'unknown'
        app.state.voice_system_prompt = None
        app.state.voice_prompt_version = None
        app.state.corpus_error = str(exc)
        logger.exception("Knowledge init failed")
    else:
        app.state.knowledge_pack = pack
        app.state.system_prompt = prompt_text
        app.state.prompt_version = prompt_version
        app.state.voice_system_prompt = None
        app.state.voice_prompt_version = None
        vpath = (os.environ.get('CHAT_VOICE_SYSTEM_PROMPT_PATH') or '').strip()
        if vpath:
            try:
                v_text, v_ver = load_system_prompt(Path(vpath))
                app.state.voice_system_prompt = v_text
                app.state.voice_prompt_version = v_ver
                logger.info('Loaded voice system prompt from %s (version=%s)', vpath, v_ver)
            except Exception as exc:
                logger.warning(
                    'Voice system prompt unavailable (%s): %s — live voice falls back to text prompt body',
                    vpath,
                    exc,
                )
    provider, _ = get_provider_and_model()
    app.state.provider_name = provider
    app.state.provider_timeout_seconds = get_provider_timeout_seconds(provider)
    if app.state.knowledge_pack is None or not app.state.system_prompt:
        app.state.chain = None
        app.state.provider_error = "Knowledge pack or system prompt failed to load"
        logger.error("Skipping provider init because knowledge is unavailable")
        yield
        return
    try:
        chain, model_id = build_llm_runnable(
            provider,
            app.state.system_prompt,
            app.state.knowledge_pack,
        )
        app.state.chain = chain
        app.state.model_id = model_id
        app.state.provider_error = None
        if isinstance(chain, GeminiRoutingChain):
            app.state.gemini_primary_model = chain.primary_id
            app.state.gemini_fallback_model = chain.fallback_id
        else:
            app.state.gemini_primary_model = None
            app.state.gemini_fallback_model = None
        logger.info("Chat provider=%s model=%s", provider, model_id)
    except (RuntimeError, ValueError) as e:
        app.state.chain = None
        app.state.gemini_primary_model = None
        app.state.gemini_fallback_model = None
        app.state.provider_error = str(e)
        logger.error("Provider init failed: %s", e)
    yield


app = FastAPI(title="GVP Chat", version="0.1.0", lifespan=lifespan)
_cors = _cors_allow_origins()
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_credentials=False,
        allow_methods=['GET', 'POST', 'OPTIONS'],
        allow_headers=['*'],
    )
app.state.knowledge_pack: dict[str, Any] | None = None
app.state.system_prompt: str = ''
app.state.prompt_version: str = 'unknown'
app.state.chain: Any = None
app.state.model_id: str = "mock-portfolio"
app.state.provider_error: str | None = None
app.state.provider_name: str = "mock"
app.state.provider_timeout_seconds: float = 15.0
app.state.pack_path: str = ""
app.state.prompt_path: str = ""
app.state.corpus_error: str | None = None
app.state.gemini_primary_model: str | None = None
app.state.gemini_fallback_model: str | None = None
app.state.transcript_store = None
app.state.live_relay_bridges: dict[str, Any] = {}
app.state.voice_system_prompt: str | None = None
app.state.voice_prompt_version: str | None = None


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True, "liveRelay": _live_relay_enabled()}


def _readiness_payload() -> tuple[bool, dict[str, Any]]:
    corpus_ready = app.state.knowledge_pack is not None and not app.state.corpus_error
    provider_ready = app.state.chain is not None and not app.state.provider_error
    ready = bool(corpus_ready and provider_ready)
    payload = {
        "ok": ready,
        "provider": {
            "name": app.state.provider_name,
            "model": app.state.model_id,
            "ready": provider_ready,
            "error": app.state.provider_error,
            "timeout_seconds": app.state.provider_timeout_seconds,
        },
        "corpus": {
            "ready": corpus_ready,
            "error": app.state.corpus_error,
            "pack_path": app.state.pack_path,
            "prompt_path": app.state.prompt_path,
            "prompt_version": app.state.prompt_version,
        },
    }
    if isinstance(app.state.chain, GeminiRoutingChain):
        from app.gemini_limit_state import primary_rate_limit_hits_today

        payload["provider"]["gemini"] = {
            "primary_model": app.state.chain.primary_id,
            "fallback_model": app.state.chain.fallback_id,
            "primary_rate_limits_today": primary_rate_limit_hits_today(),
        }
    payload['live'] = {
        'voice_model_id': live_model_id(),
        'voice_prompt_version': getattr(app.state, 'voice_prompt_version', None),
        'voice_prompt_dedicated': bool(getattr(app.state, 'voice_system_prompt', None)),
    }
    return ready, payload


def _ready_verbose_allowed(request: Request) -> bool:
    """Full /ready JSON is for local debugging or when token matches secret."""
    if os.environ.get("CHAT_READY_VERBOSE", "").strip() == "1":
        return True
    secret = os.environ.get("CHAT_READY_VERBOSE_SECRET", "").strip()
    if not secret:
        return False
    if request.query_params.get("verbose") != "1":
        return False
    token = request.query_params.get("token") or ""
    ta, tb = token.encode("utf-8"), secret.encode("utf-8")
    if len(ta) != len(tb):
        return False
    return secrets.compare_digest(ta, tb)


@app.get("/ready")
def ready(request: Request) -> JSONResponse:
    is_ready, payload = _readiness_payload()
    if _ready_verbose_allowed(request):
        body: dict[str, Any] = payload
    else:
        body = {"ok": is_ready}
    return JSONResponse(status_code=200 if is_ready else 503, content=body)


@app.post("/api/chat")
async def chat(payload: ChatRequest) -> JSONResponse:
    if payload.stream:
        return JSONResponse(
            status_code=501,
            content={
                "error": "Streaming is not implemented yet",
                "code": "stream_not_supported",
            },
        )

    if app.state.chain is None:
        msg = app.state.provider_error or "Chat backend is not configured"
        return JSONResponse(
            status_code=503,
            content={"error": msg, "code": "provider_unavailable"},
        )

    if not payload.messages:
        return JSONResponse(
            status_code=400,
            content={
                "error": "`messages` must be a non-empty array",
                "code": "empty_messages",
            },
        )
    if len(payload.messages) > MAX_MESSAGES:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"At most {MAX_MESSAGES} messages allowed",
                "code": "too_many_messages",
            },
        )

    lc_messages = _to_lc_messages(payload.messages)
    t0 = time.perf_counter()
    try:
        result = await asyncio.wait_for(
            app.state.chain.ainvoke({"messages": lc_messages}),
            timeout=app.state.provider_timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("Chat invoke timed out after %ss", app.state.provider_timeout_seconds)
        return JSONResponse(
            status_code=504,
            content={
                "error": "Upstream model timed out",
                "code": "upstream_timeout",
            },
        )
    except Exception as exc:
        logger.exception("Chat invoke failed")
        status, content = upstream_error_body(exc)
        return JSONResponse(status_code=status, content=content)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    reply_text = _reply_text_from_result(result)
    actions = _actions_from_result(result)
    tool_calls = _tool_calls_from_result(result)
    model_used = getattr(app.state.chain, "last_model_id", None) or app.state.model_id
    retrieval = _get_retrieval_snapshot(lc_messages)
    flags = _build_flags(payload.messages, reply_text, retrieval, actions)

    store = app.state.transcript_store
    if store is not None:
        now_iso = datetime.now(timezone.utc).isoformat()
        turn = {
            'capturedAt': now_iso,
            'promptVersion': app.state.prompt_version,
            'requestMessages': [row.model_dump() for row in payload.messages],
            'reply': reply_text,
            'retrieval': retrieval,
            'toolCalls': tool_calls,
            'actions': actions,
            'flags': flags,
            'latencyMs': elapsed_ms,
        }
        await store.persist_turn(
            session_id=payload.sessionId,
            created_at=now_iso,
            prompt_version=app.state.prompt_version,
            provider=app.state.provider_name,
            model=model_used,
            turn=turn,
            flags=flags,
        )

    logger.info("chat ok model=%s latency_ms=%s", model_used, elapsed_ms)
    return JSONResponse(content={"reply": reply_text, "model": model_used, "actions": actions})


@app.post("/api/live/session")
async def live_session(request: Request, payload: LiveSessionRequest) -> JSONResponse:
    if payload.sessionId:
        logger.info("live session request session=%s", payload.sessionId[:48])

    if app.state.knowledge_pack is None or not app.state.system_prompt:
        msg = app.state.corpus_error or "Knowledge pack or system prompt failed to load"
        return JSONResponse(
            status_code=503,
            content={
                "error": msg,
                "code": "corpus_unavailable",
            },
        )

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return JSONResponse(
            status_code=503,
            content={
                "error": "Gemini API key is not configured",
                "code": "gemini_key_missing",
            },
        )

    if _live_voice_strict_enabled() and not _live_relay_enabled():
        return JSONResponse(
            status_code=503,
            content={
                "error": "Voice requires WebSocket relay on this host (CHAT_LIVE_RELAY=1).",
                "code": "live_voice_requires_relay",
            },
        )

    mint_timeout = float(os.environ.get('GEMINI_LIVE_MINT_TIMEOUT_SEC', '50'))
    try:
        prompt_src = app.state.voice_system_prompt or app.state.system_prompt
        instruction = build_live_system_instruction(
            prompt_src,
            app.state.knowledge_pack,
        )
        session_payload = await asyncio.wait_for(
            mint_live_session_async(instruction),
            timeout=mint_timeout,
        )
    except asyncio.TimeoutError:
        logger.warning('live session mint timed out after %ss', mint_timeout)
        return JSONResponse(
            status_code=504,
            content={
                'error': 'Voice session setup timed out on the server. Try again.',
                'code': 'live_mint_timeout',
            },
        )
    except RuntimeError as exc:
        logger.warning("live session unavailable: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": str(exc), "code": "live_unavailable"},
        )
    except Exception as exc:
        logger.exception("live session token mint failed")
        status, content = upstream_error_body(exc)
        return JSONResponse(status_code=status, content=content)

    token_name = session_payload.pop("_authTokenName", None)
    if not token_name or not isinstance(token_name, str):
        logger.error("live session: mint returned no _authTokenName")
        return JSONResponse(
            status_code=500,
            content={"error": "Live session misconfigured", "code": "live_internal"},
        )
    relay = _live_relay_enabled()
    if relay:
        bridges: dict[str, Any] = app.state.live_relay_bridges
        _cleanup_expired_live_relays(bridges)
        bridge_id = secrets.token_urlsafe(32)
        bridges[bridge_id] = {
            "token_name": token_name,
            "handshake": dict(session_payload.get("handshake") or {}),
            "expires": time.monotonic() + _live_relay_bridge_ttl_sec(),
        }
        session_payload["websocketUrl"] = _live_relay_ws_url(request, bridge_id)
        session_payload["liveVoiceTransport"] = "relay"
        session_payload["voiceBrowserExperience"] = "relay_recommended"
        session_payload["voiceHint"] = "ok"
    else:
        session_payload["websocketUrl"] = google_constrained_browser_ws_url(token_name)
        session_payload["liveVoiceTransport"] = "direct_google"
        session_payload["voiceBrowserExperience"] = "direct_google_only"
        session_payload["voiceHint"] = "relay_required_for_voice"
    logger.info(
        "live session response model=%s transport=%s voice_browser_experience=%s voice_model_env=%s",
        session_payload.get("model"),
        session_payload.get("liveVoiceTransport"),
        session_payload.get("voiceBrowserExperience"),
        live_model_id(),
    )
    return JSONResponse(content=session_payload)


@app.websocket("/api/live/relay/{bridge_id}")
async def live_relay_ws(websocket: WebSocket, bridge_id: str) -> None:
    if not _live_relay_origin_allowed(websocket):
        origin = (websocket.headers.get('origin') or '').strip() or '<none>'
        logger.warning('live relay rejected origin=%s bridge=%s', origin, bridge_id[:12])
        await websocket.close(code=4403, reason="origin not allowed")
        return
    bridges: dict[str, Any] = app.state.live_relay_bridges
    entry = bridges.pop(bridge_id, None)
    if entry is None or float(entry.get("expires", 0)) < time.monotonic():
        await websocket.close(code=4404, reason="invalid or expired relay")
        return
    await websocket.accept()
    handshake_json = json.dumps(entry["handshake"])
    await relay_browser_to_google(
        websocket,
        token_name=str(entry["token_name"]),
        handshake_json=handshake_json,
    )


def _live_probe_allowed(request: Request) -> bool:
    """Allow the probe locally (CHAT_READY_VERBOSE=1) or with the verbose secret."""
    if os.environ.get("CHAT_READY_VERBOSE", "").strip() == "1":
        return True
    return _ready_verbose_allowed(request)


@app.get("/api/live/probe")
async def live_probe(request: Request) -> JSONResponse:
    """End-to-end voice probe: mint → upstream WS → setupComplete, no browser.

    Use to bisect timeouts: if this is OK, the bug is in the relay or browser;
    if it fails here, the bug is in mint/handshake/upstream.
    """
    if not _live_probe_allowed(request):
        return JSONResponse(status_code=404, content={"error": "not_found"})

    if app.state.knowledge_pack is None or not app.state.system_prompt:
        return JSONResponse(
            status_code=503,
            content={
                "error": app.state.corpus_error or "Knowledge pack missing",
                "code": "corpus_unavailable",
            },
        )

    if not os.environ.get("GEMINI_API_KEY", "").strip():
        return JSONResponse(
            status_code=503,
            content={"error": "Gemini API key is not configured", "code": "gemini_key_missing"},
        )

    from app import live_gemini as _lg

    prompt_src = app.state.voice_system_prompt or app.state.system_prompt
    instruction = build_live_system_instruction(prompt_src, app.state.knowledge_pack)
    try:
        result = await asyncio.wait_for(
            _lg.probe_live_session(instruction),
            timeout=60,
        )
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"ok": False, "error": "probe_timeout_60s"},
        )
    logger.info("live probe result=%s", {k: v for k, v in result.items() if k != 'first_frame'})
    return JSONResponse(status_code=200 if result.get('ok') else 502, content=result)


@app.post("/api/live/transcript")
async def live_transcript(payload: LiveTranscriptTurn) -> JSONResponse:
    """Persist a single voice turn (input + output transcription pair).

    Best-effort: returns 200 even if no transcript store is configured, since
    voice still works without persistence. Mirrors the text-chat persist path so
    the admin transcripts panel sees voice and text turns side by side.
    """
    store = app.state.transcript_store
    if store is None:
        return JSONResponse(status_code=204, content=None)

    user_text = (payload.userText or "").strip()
    assistant_text = (payload.assistantText or "").strip()
    if not user_text and not assistant_text:
        return JSONResponse(status_code=204, content=None)

    now_iso = datetime.now(timezone.utc).isoformat()
    captured_at = (payload.capturedAt or now_iso).strip() or now_iso
    transport = (payload.transport or "live").strip() or "live"
    tool_calls = payload.toolCalls or []

    turn = {
        "capturedAt": captured_at,
        "promptVersion": app.state.prompt_version,
        "modality": "voice",
        "transport": transport,
        "requestMessages": [
            {"role": "user", "content": user_text},
        ] if user_text else [],
        "reply": assistant_text,
        "toolCalls": tool_calls,
        "actions": [],
        "flags": {},
    }
    flags: dict[str, bool] = {}

    try:
        await store.persist_turn(
            session_id=payload.sessionId,
            created_at=captured_at,
            prompt_version=app.state.prompt_version,
            provider=app.state.provider_name,
            model=live_model_id(),
            turn=turn,
            flags=flags,
        )
    except Exception:
        logger.exception("Failed to persist voice transcript")
        return JSONResponse(
            status_code=500,
            content={"error": "persist_failed", "code": "transcript_store_error"},
        )

    return JSONResponse(status_code=204, content=None)


@app.exception_handler(RequestValidationError)
async def request_validation_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    del request
    errs = exc.errors()
    codes = {e.get("type") for e in errs}
    if "json_invalid" in codes:
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid JSON body", "code": "malformed_json"},
        )
    detail = errs[0].get("msg", "Invalid request") if errs else "Invalid request"
    return JSONResponse(
        status_code=400,
        content={"error": detail, "code": "validation_error"},
    )
