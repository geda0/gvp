"""LLM chains by CHAT_PROVIDER."""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_core.tools import tool

from app.knowledge_context import build_context, compact_history, serialize_context_xml

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
    return status, str(body.get("code", "model_error")), str(
        body.get("error", "Upstream model error")
    )


@tool
def open_resume() -> str:
    """Surface a resume action for the visitor."""
    return "Open resume"


@tool
def open_contact_form(subject: str = "", message: str = "") -> str:
    """Surface a prefilled contact-form action for the visitor."""
    del subject, message
    return "Open contact form"


def chat_tools() -> list[Any]:
    return [open_resume, open_contact_form]


def _inject_retrieved(
    knowledge_pack: dict[str, Any],
    inp: dict[str, Any],
) -> dict[str, Any]:
    raw_messages = list(inp["messages"])
    compacted = compact_history(raw_messages)
    last = ''
    for m in reversed(compacted):
        if getattr(m, "type", None) == "human":
            last = str(m.content)
            break
    history_text = ' '.join(
        str(getattr(m, 'content', ''))[:300] for m in compacted[-6:]
    )
    context = build_context(last, history_text, knowledge_pack)
    knowledge_xml = serialize_context_xml(context)
    messages = [HumanMessage(content=knowledge_xml), *compacted]
    return {
        "messages": messages,
        "faq_match": context.get("faq_match"),
    }


def _mock_llm_reply(prompt_value: Any) -> AIMessage:
    msgs = prompt_value.to_messages()
    last = ''
    knowledge = ''
    for m in reversed(msgs):
        if isinstance(m, HumanMessage):
            if not knowledge and str(m.content).startswith('<knowledge_pack>'):
                knowledge = str(m.content)
                continue
            if not last:
                last = str(m.content)
        if last and knowledge:
            break
    query = last.lower()
    if (
        'tbm' in query
        or 'technology business management' in query
        or 'financial management' in query
        or 'financial planning' in query
    ) and 'Apptio' in knowledge:
        text = "Marwan's materials link Technology Business Management work to Apptio (IBM)."
    elif ('resume' in query or 'cv' in query) and 'trigger_tool' in knowledge:
        text = "Marwan keeps a public resume PDF on the site."
    else:
        text = "I can answer questions about Marwan's work using the provided knowledge pack."
    return AIMessage(content=text)


def build_llm_runnable(
    provider: str,
    system_prompt: str,
    knowledge_pack: dict[str, Any],
) -> tuple[Any, str]:
    """Return (chain, model_id). Chain input: {\"messages\": list[BaseMessage]}."""
    provider = provider.lower()
    model_id = _model_id_for_provider(provider)
    timeout_s = _get_timeout_seconds(provider)

    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            MessagesPlaceholder("messages"),
        ]
    )

    inject = RunnableLambda(lambda inp: _inject_retrieved(knowledge_pack, inp))
    tools = chat_tools()

    if provider == "mock":
        reply_fn = RunnableLambda(_mock_llm_reply)
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
            tools=tools,
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
        llm = llm.bind_tools(tools)
        chain = inject | prompt | llm
        return chain, model_id

    raise ValueError(f"Unknown CHAT_PROVIDER: {provider}")


def get_provider_and_model() -> tuple[str, str]:
    p = _get_provider_name()
    return p, _model_id_for_provider(p)
