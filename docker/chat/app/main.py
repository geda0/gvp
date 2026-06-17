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

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.gemini_routing import GeminiRoutingChain
from app.messages import Msg, MsgChunk, _Acc
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
from app.providers import (
    build_llm_runnable,
    get_provider_and_model,
    get_provider_timeout_seconds,
)
from app.transcript_store import build_transcript_store
from app.upstream_errors import upstream_error_body

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


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
    # Voice telemetry (Phase 6 — admin dashboard): every field is optional so
    # older FE builds keep working. The backend coerces to safe ints/floats
    # before persistence so no garbage lands in DynamoDB.
    intent: str | None = Field(default=None, max_length=16)
    turnDurationMs: int | None = Field(default=None, ge=0, le=30 * 60 * 1000)
    audioInBytes: int | None = Field(default=None, ge=0, le=200 * 1024 * 1024)
    audioOutBytes: int | None = Field(default=None, ge=0, le=200 * 1024 * 1024)
    interrupted: bool | None = Field(default=None)


def _to_lc_messages(rows: list[ChatMessageIn]) -> list[Msg]:
    out: list[Msg] = []
    for row in rows:
        if row.role == "user":
            out.append(Msg(role="human", content=row.content))
        elif row.role == "assistant":
            out.append(Msg(role="ai", content=row.content))
        else:
            out.append(Msg(role="system", content=row.content))
    return out


def _reply_text_from_result(result: Any) -> str:
    if not isinstance(result, Msg):
        return str(result)
    content = result.content
    if isinstance(content, str):
        return content
    return str(content)


def _chunk_text(chunk: Any) -> str:
    """Extract the text delta from a streamed chunk (MsgChunk) or a final Msg."""
    if isinstance(chunk, MsgChunk):
        return chunk.text or ''
    content = getattr(chunk, 'content', '')
    if isinstance(content, str):
        return content
    return ''


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
    if not isinstance(result, Msg):
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
    if not isinstance(result, Msg):
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


def _get_retrieval_snapshot(messages: list[Msg]) -> dict[str, Any]:
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
app.state.voice_system_prompt: str | None = None
app.state.voice_prompt_version: str | None = None


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


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
    # Persistence diagnostics — first stop when "the admin shows 0 sessions"
    # is reported. configured=false means CHAT_TRANSCRIPTS_TABLE is unset on
    # the chat host (every /api/chat + /api/live/transcript silently no-ops).
    # writes_failed climbing means IAM or table not found; last_error has the
    # boto3 reason.
    store = getattr(app.state, 'transcript_store', None)
    if store is not None and hasattr(store, 'stats'):
        s = store.stats()
        payload['transcripts'] = {
            'configured': True,
            # `disabled=true` means boto3 import failed at startup (or some
            # other initialization issue) — writes are dropped even though
            # the env var is set. Distinct from configured=false (no env).
            'disabled': bool(s.get('disabled')),
            'table_name': s.get('table_name'),
            'writes_attempted': s.get('writes_attempted', 0),
            'writes_succeeded': s.get('writes_succeeded', 0),
            'writes_failed': s.get('writes_failed', 0),
            'last_attempt_at': s.get('last_attempt_at'),
            'last_success_at': s.get('last_success_at'),
            'last_error': s.get('last_error'),
        }
    else:
        payload['transcripts'] = {
            'configured': False,
            'reason': (
                'CHAT_TRANSCRIPTS_TABLE env is empty; chat + voice persists '
                'are silently dropped (204 response with no DynamoDB write).'
            ),
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


def _check_admin_key(request: Request) -> bool:
    """Validate x-admin-key with timing-safe compare. Mirrors the contact admin
    Lambda check so the same secret works for chat host introspection."""
    import hmac

    expected = (os.environ.get('ADMIN_API_KEY') or '').strip()
    if not expected:
        return False
    provided = request.headers.get('x-admin-key') or ''
    if not provided:
        return False
    return hmac.compare_digest(expected.encode('utf-8'), provided.encode('utf-8'))


@app.get("/api/chat/host-status")
def chat_host_status(request: Request) -> JSONResponse:
    """Persistence + provider health snapshot, consumed by the admin panel.

    Exposes operational counters only (no transcript content). Gated by
    ADMIN_API_KEY so it's safe to call cross-origin from the admin SPA.
    Lets a reviewer answer 'is persistence actually firing?' from the
    dashboard without SSHing to ECS or hitting /ready (which is gated by
    IP allowlist for liveness probes)."""
    if not _check_admin_key(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    store = app.state.transcript_store
    chain = app.state.chain
    # Surface the live voice preset so the admin can confirm at a glance which
    # voice every minted Live session is locked to (default Charon — deep male).
    try:
        from app.live_gemini import _live_voice_name
        live_voice = _live_voice_name()
    except Exception:
        live_voice = None
    return JSONResponse(content={
        "provider": app.state.provider_name,
        "providerConfigured": chain is not None,
        "providerError": app.state.provider_error,
        "model": app.state.model_id,
        "primaryModel": getattr(chain, 'primary_id', None),
        "fallbackModel": getattr(chain, 'fallback_id', None),
        "lastModelUsed": getattr(chain, 'last_model_id', None),
        "providerTimeoutSeconds": app.state.provider_timeout_seconds,
        "promptVersion": app.state.prompt_version,
        "liveVoiceName": live_voice,
        "transcriptStore": store.stats() if store is not None else {
            'configured': False,
        },
    })


_SMOKE_RANK = {"pass": 0, "warn": 1, "fail": 2}


def _smoke_check(name: str, status: str, started: float, detail: str, cost: str = "free") -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "latencyMs": int((time.monotonic() - started) * 1000),
        "detail": detail,
        "cost": cost,
    }


@app.get("/api/chat/smoke")
async def chat_smoke(request: Request) -> JSONResponse:
    """Smoke test for the chat host. CHEAP tier: is the provider/chain configured.
    DEEP tier (?deep=1): a REAL Gemini Live probe (mint -> upstream WS -> setupComplete)
    that proves the live model + credential actually work — what a static 'ok' misses.
    Admin-key gated (same secret as host-status, so the admin SPA + the daily-report
    Lambda can call it). Never raises: a probe failure becomes a 'fail' check, 200."""
    if not _check_admin_key(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    deep = (request.query_params.get("deep") or "").strip() in ("1", "true", "yes")
    checks: list[dict[str, Any]] = []

    t0 = time.monotonic()
    chain = app.state.chain
    if chain is not None:
        checks.append(_smoke_check(
            "chat_host", "pass", t0,
            f"provider={app.state.provider_name} model={app.state.model_id}"))
    else:
        checks.append(_smoke_check(
            "chat_host", "fail", t0, app.state.provider_error or "chain not configured"))

    if deep:
        key_ok = bool((os.environ.get("GEMINI_API_KEY") or "").strip())
        if chain is None or not key_ok:
            checks.append(_smoke_check(
                "chat_model_live", "fail", time.monotonic(),
                "skipped: chain or GEMINI_API_KEY not ready", cost="paid"))
        else:
            t1 = time.monotonic()
            try:
                from app import live_gemini as _lg
                prompt_src = app.state.voice_system_prompt or app.state.system_prompt or ""
                if app.state.knowledge_pack is not None and prompt_src:
                    instruction = build_live_system_instruction(prompt_src, app.state.knowledge_pack)
                else:
                    instruction = "You are a health probe. Reply briefly."
                timeout = float(os.environ.get("SMOKE_LIVE_TIMEOUT", "25") or 25)
                result = await asyncio.wait_for(_lg.probe_live_session(instruction), timeout=timeout)
                if result.get("ok"):
                    checks.append(_smoke_check(
                        "chat_model_live", "pass", t1, "live session setupComplete", cost="paid"))
                else:
                    checks.append(_smoke_check(
                        "chat_model_live", "fail", t1,
                        str(result.get("error") or "live probe failed"), cost="paid"))
            except asyncio.TimeoutError:
                checks.append(_smoke_check(
                    "chat_model_live", "fail", t1, "live probe timeout", cost="paid"))
            except Exception as exc:  # noqa: BLE001 - smoke must never raise
                checks.append(_smoke_check("chat_model_live", "fail", t1, str(exc)[:200], cost="paid"))

    overall = "pass"
    for c in checks:
        if _SMOKE_RANK.get(c["status"], 2) > _SMOKE_RANK[overall]:
            overall = c["status"]
    return JSONResponse(content={"overall": overall, "depth": "deep" if deep else "cheap", "checks": checks})


async def _persist_text_turn(
    payload: ChatRequest,
    lc_messages: list[Msg],
    reply_text: str,
    actions: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
    model_used: str,
    elapsed_ms: int,
    *,
    stream: bool = False,
    first_token_ms: int | None = None,
    chunk_count: int | None = None,
    fallback_used: bool = False,
    status: str = 'ok',
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    """Persist a text turn (success or failure).

    Streaming-specific fields:
      stream            - whether the request used SSE
      first_token_ms    - wall-clock until first non-empty delta (None if none)
      chunk_count       - number of chunks observed (None for non-stream)
      fallback_used     - True when GeminiRoutingChain swapped to the secondary
      status            - 'ok' | 'error' | 'timeout'
      error_code/_msg   - populated on non-'ok' paths so failed attempts show up
                          in the admin panel instead of vanishing.
    """
    store = app.state.transcript_store
    if store is None:
        return
    retrieval = _get_retrieval_snapshot(lc_messages)
    flags = _build_flags(payload.messages, reply_text, retrieval, actions)
    now_iso = datetime.now(timezone.utc).isoformat()
    turn: dict[str, Any] = {
        'capturedAt': now_iso,
        'promptVersion': app.state.prompt_version,
        # Tag every text turn so the admin dashboard can split voice vs
        # text without pattern-matching on which fields are present.
        'modality': 'text',
        'requestMessages': [row.model_dump() for row in payload.messages],
        'reply': reply_text,
        'retrieval': retrieval,
        'toolCalls': tool_calls,
        'actions': actions,
        'flags': flags,
        'latencyMs': elapsed_ms,
        'stream': bool(stream),
        'status': status,
        'outputCharCount': len(reply_text or ''),
        'fallbackUsed': bool(fallback_used),
    }
    if first_token_ms is not None:
        turn['firstTokenLatencyMs'] = int(first_token_ms)
    if chunk_count is not None:
        turn['streamChunkCount'] = int(chunk_count)
    if status != 'ok':
        turn['errorCode'] = error_code or 'unknown'
        if error_message:
            turn['errorMessage'] = str(error_message)[:400]
    await store.persist_turn(
        session_id=payload.sessionId,
        created_at=now_iso,
        prompt_version=app.state.prompt_version,
        provider=app.state.provider_name,
        model=model_used,
        turn=turn,
        flags=flags,
    )


def _fallback_used(chain: Any) -> bool:
    """True when the routing chain settled on the secondary Gemini model."""
    primary = getattr(chain, 'primary_id', None)
    last = getattr(chain, 'last_model_id', None)
    if not primary or not last:
        return False
    return primary != last


def _sse_frame(event: str, data: Any) -> bytes:
    if not isinstance(data, str):
        data = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


@app.post("/api/chat")
async def chat(payload: ChatRequest) -> Any:
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

    if payload.stream:
        return StreamingResponse(
            _chat_stream(payload, lc_messages),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                # Disable proxy buffering (nginx, ALB) so tokens flush in real time.
                "X-Accel-Buffering": "no",
            },
        )

    t0 = time.perf_counter()
    try:
        result = await asyncio.wait_for(
            app.state.chain.ainvoke({"messages": lc_messages}),
            timeout=app.state.provider_timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("Chat invoke timed out after %ss", app.state.provider_timeout_seconds)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        try:
            await _persist_text_turn(
                payload, lc_messages, '', [], [],
                getattr(app.state.chain, 'last_model_id', None) or app.state.model_id,
                elapsed_ms,
                stream=False,
                fallback_used=_fallback_used(app.state.chain),
                status='timeout',
                error_code='upstream_timeout',
                error_message=f'ainvoke exceeded {app.state.provider_timeout_seconds}s',
            )
        except Exception:
            logger.exception("Chat invoke failure-turn persist failed")
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
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        try:
            await _persist_text_turn(
                payload, lc_messages, '', [], [],
                getattr(app.state.chain, 'last_model_id', None) or app.state.model_id,
                elapsed_ms,
                stream=False,
                fallback_used=_fallback_used(app.state.chain),
                status='error',
                error_code=str(content.get('code') or 'model_error'),
                error_message=str(content.get('error') or type(exc).__name__),
            )
        except Exception:
            logger.exception("Chat invoke failure-turn persist failed")
        return JSONResponse(status_code=status, content=content)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    reply_text = _reply_text_from_result(result)
    actions = _actions_from_result(result)
    tool_calls = _tool_calls_from_result(result)
    model_used = getattr(app.state.chain, "last_model_id", None) or app.state.model_id

    await _persist_text_turn(
        payload, lc_messages, reply_text, actions, tool_calls, model_used, elapsed_ms,
        stream=False,
        fallback_used=_fallback_used(app.state.chain),
        status='ok',
    )

    logger.info("chat ok model=%s latency_ms=%s", model_used, elapsed_ms)
    return JSONResponse(content={"reply": reply_text, "model": model_used, "actions": actions})


async def _chat_stream(
    payload: ChatRequest,
    lc_messages: list[Msg],
):
    """Yield Server-Sent Events for the assistant turn.

    Events:
      - token: {"delta": "..."}    one or more per turn
      - done:  {"reply": "...", "model": "...", "actions": [...]}
      - error: {"error": "...", "code": "..."}  terminal, sent in place of done
    """
    t0 = time.perf_counter()
    aggregated: Any = None
    acc = _Acc()
    saw_chunk = False
    chain = app.state.chain
    timeout_s = app.state.provider_timeout_seconds
    deadline = time.monotonic() + timeout_s
    chunk_count = 0
    first_token_ms: int | None = None
    stream_status = 'ok'
    error_code: str | None = None
    error_message: str | None = None

    # Per-chunk wait_for keeps a single end-to-end budget while supporting
    # Python 3.10 (asyncio.timeout is 3.11+).
    iterator = chain.astream({"messages": lc_messages}).__aiter__()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError
            try:
                chunk = await asyncio.wait_for(iterator.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                break
            chunk_count += 1
            # Risk seam #2: replace the AIMessageChunk.__add__ fold with an
            # explicit accumulator. Streaming adapters yield MsgChunk deltas
            # (text concatenated, tool_calls collected, finalized once); a
            # non-chunk runnable (e.g. the mock) yields a single final Msg,
            # which we keep verbatim as the source of truth.
            if isinstance(chunk, MsgChunk):
                acc.add(chunk)
                saw_chunk = True
            else:
                aggregated = chunk
            delta = _chunk_text(chunk)
            if delta:
                if first_token_ms is None:
                    first_token_ms = int((time.perf_counter() - t0) * 1000)
                yield _sse_frame("token", {"delta": delta})
    except asyncio.TimeoutError:
        logger.warning("Chat stream timed out after %ss", timeout_s)
        stream_status = 'timeout'
        error_code = 'upstream_timeout'
        error_message = f'astream exceeded {timeout_s}s after {chunk_count} chunks'
        sse_error = _sse_frame("error", {
            "error": "Upstream model timed out",
            "code": "upstream_timeout",
        })
    except Exception as exc:
        logger.exception("Chat stream failed")
        _status, content = upstream_error_body(exc)
        stream_status = 'error'
        error_code = str(content.get('code') or 'model_error')
        error_message = str(content.get('error') or type(exc).__name__)
        sse_error = _sse_frame("error", content)
    else:
        sse_error = None

    # Finalize the streamed deltas into one Msg (text + collected tool_calls).
    # Even on a mid-stream error this captures whatever flushed so far, matching
    # the old fold's partial-aggregate persistence. A non-chunk mock instead
    # left its final Msg in `aggregated` directly.
    if saw_chunk:
        aggregated = acc.finalize()

    reply_text = _reply_text_from_result(aggregated) if aggregated is not None else ''
    actions = _actions_from_result(aggregated) if stream_status == 'ok' and aggregated is not None else []
    tool_calls = _tool_calls_from_result(aggregated) if aggregated is not None else []
    model_used = getattr(chain, "last_model_id", None) or app.state.model_id
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    # Persist the turn whether it succeeded, errored, or timed out. The
    # admin panel needs to see failed attempts; otherwise "I sent a chat
    # and nothing happened" is invisible until someone reads ECS logs.
    try:
        await _persist_text_turn(
            payload, lc_messages, reply_text, actions, tool_calls, model_used, elapsed_ms,
            stream=True,
            first_token_ms=first_token_ms,
            chunk_count=chunk_count,
            fallback_used=_fallback_used(chain),
            status=stream_status,
            error_code=error_code,
            error_message=error_message,
        )
    except Exception:
        # Persistence failures should not break the user-visible response.
        logger.exception("Chat stream transcript persist failed")

    if sse_error is not None:
        yield sse_error
        return

    yield _sse_frame("done", {
        "reply": reply_text,
        "model": model_used,
        "actions": actions,
    })
    logger.info(
        "chat stream ok model=%s latency_ms=%s first_token_ms=%s chunks=%s fallback=%s",
        model_used, elapsed_ms, first_token_ms, chunk_count, _fallback_used(chain),
    )


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
    # Browser-direct only (ADR-0007): the browser opens Google's Live WSS itself with the
    # single-use ephemeral token; the server holds no WebSocket. The long-lived key never
    # transits — only the ~3-min one-use token does.
    session_payload["websocketUrl"] = google_constrained_browser_ws_url(token_name)
    session_payload["liveVoiceTransport"] = "direct_google"
    session_payload["voiceBrowserExperience"] = "direct_google"
    session_payload["voiceHint"] = "ok"
    logger.info(
        "live session response model=%s transport=%s voice_browser_experience=%s voice_model_env=%s",
        session_payload.get("model"),
        session_payload.get("liveVoiceTransport"),
        session_payload.get("voiceBrowserExperience"),
        live_model_id(),
    )
    return JSONResponse(content=session_payload)


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
    greet_text = (request.query_params.get('greet') or '').strip() or None
    if greet_text == '1':
        # Default ("cold") greeting the FE plays when mic permission is not yet
        # granted — short, single-action: tap the mic. ?greet=warm exercises
        # the variant for visitors whose permission was already granted on a
        # previous session (we attach the mic immediately and only speak the
        # first half of the greeting, then let the user fill the silence).
        greet_text = (
            "Hi! I'm your AI Assistant. Just tap the mic to talk."
        )
    elif greet_text == 'warm':
        greet_text = "Hi! I'm your AI Assistant."
    try:
        result = await asyncio.wait_for(
            _lg.probe_live_session(instruction, greet_text=greet_text),
            timeout=90 if greet_text else 60,
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
        # Surface the misconfiguration explicitly instead of pretending we
        # persisted. The FE swallows the error via fire-and-forget; manual
        # curl + browser DevTools shows the 503 immediately so the operator
        # can spot "CHAT_TRANSCRIPTS_TABLE is empty" without reading logs.
        return JSONResponse(
            status_code=503,
            content={
                'error': 'CHAT_TRANSCRIPTS_TABLE is not configured on this chat host',
                'code': 'transcripts_not_configured',
            },
        )

    user_text = (payload.userText or "").strip()
    assistant_text = (payload.assistantText or "").strip()
    if not user_text and not assistant_text:
        return JSONResponse(status_code=204, content=None)

    now_iso = datetime.now(timezone.utc).isoformat()
    captured_at = (payload.capturedAt or now_iso).strip() or now_iso
    transport = (payload.transport or "live").strip() or "live"
    tool_calls = payload.toolCalls or []
    intent = (payload.intent or "").strip().lower() or None
    if intent not in (None, "cold", "warm"):
        intent = None

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
        # Voice telemetry — kept inside the turn so it ages with TTL alongside
        # the rest of the turn data. Coerce to plain ints (DynamoDB Number)
        # via int(); None values are dropped so the item stays compact.
        "intent": intent,
        "turnDurationMs": int(payload.turnDurationMs) if payload.turnDurationMs is not None else None,
        "audioInBytes": int(payload.audioInBytes) if payload.audioInBytes is not None else None,
        "audioOutBytes": int(payload.audioOutBytes) if payload.audioOutBytes is not None else None,
        "interrupted": bool(payload.interrupted) if payload.interrupted is not None else None,
    }
    # Drop None keys so DynamoDB items stay tidy and partial backfills work.
    turn = {k: v for k, v in turn.items() if v is not None}
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
