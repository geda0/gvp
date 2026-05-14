"""FastAPI chat API: portfolio-grounded LangChain backends."""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field, field_validator

from app.context import CorpusIndex, build_chunks, summarized_corpus
from app.providers import build_llm_runnable, get_provider_and_model

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

MAX_MESSAGES = int(os.environ.get("CHAT_MAX_MESSAGES", "32"))
MAX_CONTENT_LEN = int(os.environ.get("CHAT_MAX_CONTENT_LEN", "8000"))


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _corpus_paths() -> tuple[Path, Path]:
    r = os.environ.get("CORPUS_RESUME_PATH") or os.environ.get("CORPUS_RESUME")
    p = os.environ.get("CORPUS_PROJECTS_PATH") or os.environ.get("CORPUS_PROJECTS")
    if r and p:
        return Path(r), Path(p)
    root = _repo_root()
    return root / "resume" / "resume.json", root / "data" / "projects.json"


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    resume_p, projects_p = _corpus_paths()
    logger.info("Loading corpus from %s and %s", resume_p, projects_p)
    chunks = build_chunks(resume_p, projects_p)
    app.state.corpus_index = CorpusIndex(chunks)
    app.state.corpus_summary = summarized_corpus(chunks)
    provider, _ = get_provider_and_model()
    try:
        chain, model_id = build_llm_runnable(
            provider,
            app.state.corpus_index,
            app.state.corpus_summary,
        )
        app.state.chain = chain
        app.state.model_id = model_id
        app.state.provider_error = None
        logger.info("Chat provider=%s model=%s", provider, model_id)
    except (RuntimeError, ValueError) as e:
        app.state.chain = None
        app.state.provider_error = str(e)
        logger.error("Provider init failed: %s", e)
    yield


app = FastAPI(title="GVP Chat", version="0.1.0", lifespan=lifespan)
app.state.corpus_index: CorpusIndex | None = None
app.state.corpus_summary: str = ""
app.state.chain: Any = None
app.state.model_id: str = "mock-portfolio"
app.state.provider_error: str | None = None


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


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
        result = await app.state.chain.ainvoke({"messages": lc_messages})
    except Exception:
        logger.exception("Chat invoke failed")
        return JSONResponse(
            status_code=502,
            content={"error": "Upstream model error", "code": "model_error"},
        )
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    reply_text = result.content if isinstance(result, AIMessage) else str(result)
    logger.info("chat ok model=%s latency_ms=%s", app.state.model_id, elapsed_ms)
    return JSONResponse(content={"reply": reply_text, "model": app.state.model_id})


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
