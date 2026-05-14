"""LLM chains by CHAT_PROVIDER."""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import Runnable, RunnableLambda

logger = logging.getLogger(__name__)


def _get_provider_name() -> str:
    return (os.environ.get("CHAT_PROVIDER") or "mock").strip().lower()


def _get_timeout_seconds(provider: str) -> float:
    provider = provider.lower()
    if provider == "gemini":
        val = os.environ.get("GEMINI_TIMEOUT_SECONDS")
    elif provider == "openai":
        val = os.environ.get("OPENAI_TIMEOUT_SECONDS")
    else:
        val = os.environ.get("CHAT_PROVIDER_TIMEOUT_SECONDS")
    if val is None:
        val = os.environ.get("CHAT_PROVIDER_TIMEOUT_SECONDS")
    if val is None:
        return 15.0
    try:
        parsed = float(val)
    except ValueError:
        logger.warning("Invalid timeout value %r; using default 15s", val)
        return 15.0
    return max(parsed, 0.1)


def get_provider_timeout_seconds(provider: str) -> float:
    return _get_timeout_seconds(provider)


def _gemini_primary_model_id() -> str:
    return (os.environ.get('GEMINI_MODEL') or 'gemini-3.1-flash-lite').strip()


def _gemini_fallback_model_id() -> str:
    return (os.environ.get('GEMINI_FALLBACK_MODEL') or 'gemma-4-26b-a4b-it').strip()


def _model_id_for_provider(provider: str) -> str:
    if provider == "mock":
        return "mock-portfolio"
    if provider == "gemini":
        return _gemini_primary_model_id()
    if provider == "openai":
        return os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
    return provider


def _extract_status_code(exc: BaseException) -> int | None:
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        status = getattr(cur, "status_code", None)
        if isinstance(status, int):
            return status
        response = getattr(cur, "response", None)
        if response is not None:
            status = getattr(response, "status_code", None)
            if isinstance(status, int):
                return status
        cur = cur.__cause__ or cur.__context__
    return None


def classify_upstream_exception(exc: BaseException) -> tuple[int, str, str]:
    from app.upstream_errors import upstream_error_body

    status, body = upstream_error_body(exc)
    return status, str(body.get("code", "model_error")), str(body.get("error", "Upstream model error"))


def _inject_retrieved(
    corpus_index: Any,
    corpus_digest: str,
    inp: dict[str, Any],
) -> dict[str, Any]:
    msgs = inp["messages"]
    last = ""
    for m in reversed(msgs):
        if getattr(m, "type", None) == "human":
            last = str(m.content)
            break
    retrieved = ""
    if corpus_index is not None and last:
        bits = corpus_index.retrieve(last, k=4)
        retrieved = "\n".join(bits)
    return {
        "messages": msgs,
        "retrieved": retrieved or "(none)",
        "corpus_digest": corpus_digest[:12000],
    }


def _mock_llm_reply(corpus_index: Any, prompt_value: Any) -> AIMessage:
    msgs = prompt_value.to_messages()
    last = ""
    for m in reversed(msgs):
        if isinstance(m, HumanMessage):
            last = str(m.content)
            break
    bits: list[str] = []
    if corpus_index is not None and last:
        bits = corpus_index.retrieve(last, k=4)
    ctx = "\n".join(bits) if bits else "(no matching corpus snippets)"
    text = (
        "Portfolio assistant (mock). Relevant excerpts from Marwan's materials:\n"
        f"{ctx}\n"
        "In production, a full model would answer using only this context."
    )
    return AIMessage(content=text)


def build_llm_runnable(
    provider: str,
    corpus_index: Any,
    corpus_digest: str,
) -> tuple[Any, str]:
    """Return (chain, model_id). Chain input: {\"messages\": list[BaseMessage]}."""
    provider = provider.lower()
    model_id = _model_id_for_provider(provider)
    timeout_s = _get_timeout_seconds(provider)

    system_template = (
        "You are a concise assistant for Marwan Elgendy's portfolio site. "
        "Ground answers in the digest and retrieved excerpts; do not invent "
        "employers or projects. If the question is unrelated, say you only "
        "discuss this portfolio.\n\n"
        "Portfolio digest:\n{corpus_digest}\n\n"
        "Retrieved excerpts (BM25):\n{retrieved}"
    )
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system_template),
            MessagesPlaceholder("messages"),
        ]
    )

    inject = RunnableLambda(
        lambda inp: _inject_retrieved(corpus_index, corpus_digest, inp)
    )

    if provider == "mock":
        reply_fn = RunnableLambda(lambda pv: _mock_llm_reply(corpus_index, pv))
        chain: Runnable = inject | prompt | reply_fn
        return chain, model_id

    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set")

        from app.gemini_routing import GeminiRoutingChain

        primary_id = _gemini_primary_model_id()
        fallback_id = _gemini_fallback_model_id()
        if primary_id == fallback_id:
            raise RuntimeError("GEMINI_MODEL and GEMINI_FALLBACK_MODEL must differ")

        chain = GeminiRoutingChain(
            inject | prompt,
            primary_id,
            fallback_id,
            key,
            timeout_s,
        )
        return chain, primary_id

    if provider == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set")

        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=model_id,
            temperature=0.2,
            api_key=key,
            timeout=timeout_s,
        )
        chain = inject | prompt | llm
        return chain, model_id

    raise ValueError(f"Unknown CHAT_PROVIDER: {provider}")


def get_provider_and_model() -> tuple[str, str]:
    p = _get_provider_name()
    return p, _model_id_for_provider(p)
