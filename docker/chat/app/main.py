"""FastAPI chat API: portfolio-grounded LangChain backends."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field, field_validator

from app.gemini_routing import GeminiRoutingChain
from app.knowledge_context import (
    default_pack_dir,
    default_system_prompt_path,
    load_knowledge_pack,
    load_system_prompt,
)
from app.providers import (
    build_llm_runnable,
    get_provider_and_model,
    get_provider_timeout_seconds,
)
from app.upstream_errors import upstream_error_body

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

MAX_MESSAGES = int(os.environ.get("CHAT_MAX_MESSAGES", "32"))
MAX_CONTENT_LEN = int(os.environ.get("CHAT_MAX_CONTENT_LEN", "8000"))


def _cors_allow_origins() -> list[str]:
    raw = os.environ.get('CHAT_CORS_ORIGINS', '').strip()
    if not raw:
        return []
    return [o.strip() for o in raw.split(',') if o.strip()]


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    pack_dir = default_pack_dir()
    prompt_path = default_system_prompt_path()
    logger.info("Loading knowledge pack from %s", pack_dir)
    app.state.pack_path = str(pack_dir)
    app.state.prompt_path = str(prompt_path)
    app.state.corpus_error = None
    try:
        pack = load_knowledge_pack(pack_dir)
        prompt_text, prompt_version = load_system_prompt(prompt_path)
    except Exception as exc:
        app.state.knowledge_pack = None
        app.state.system_prompt = ''
        app.state.prompt_version = 'unknown'
        app.state.corpus_error = str(exc)
        logger.exception("Knowledge init failed")
    else:
        app.state.knowledge_pack = pack
        app.state.system_prompt = prompt_text
        app.state.prompt_version = prompt_version
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
    return ready, payload


@app.get("/ready")
def ready() -> JSONResponse:
    is_ready, payload = _readiness_payload()
    return JSONResponse(status_code=200 if is_ready else 503, content=payload)


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
    except TimeoutError:
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
    model_used = getattr(app.state.chain, "last_model_id", None) or app.state.model_id
    logger.info("chat ok model=%s latency_ms=%s", model_used, elapsed_ms)
    return JSONResponse(content={"reply": reply_text, "model": model_used, "actions": actions})


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
