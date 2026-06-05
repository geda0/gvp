"""LLM chains by CHAT_PROVIDER (mock + Gemini via the google-genai SDK)."""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

from app.knowledge_context import build_context, compact_history, serialize_context_xml
from app.messages import Msg

logger = logging.getLogger(__name__)


def _get_provider_name() -> str:
    return (os.environ.get("CHAT_PROVIDER") or "mock").strip().lower()


def _get_timeout_seconds(provider: str) -> float:
    provider = provider.lower()
    if provider == "gemini":
        val = os.environ.get("GEMINI_TIMEOUT_SECONDS")
    else:
        val = os.environ.get("CHAT_PROVIDER_TIMEOUT_SECONDS")
    if val is None:
        val = os.environ.get("CHAT_PROVIDER_TIMEOUT_SECONDS")
    if val is None:
        # Gemini: portfolio chats ship a large knowledge_pack; 15s often trips on
        # multi-turn + tool calls. Stay under typical API Gateway ~30s integration
        # ceiling while leaving headroom vs Lambda 60s.
        if provider == "gemini":
            return 28.0
        return 15.0
    try:
        parsed = float(val)
    except ValueError:
        logger.warning("Invalid timeout value %r; using default 15s", val)
        return 15.0
    # Cap Gemini waits below common API Gateway integration limits.
    ceiling = 55.0 if provider == "gemini" else 120.0
    return max(min(parsed, ceiling), 0.1)


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


def chat_tools() -> list[Any]:
    """Function-call declarations for the Gemini text path: open_resume and
    open_contact_form (the same two declarations Live uses, minus
    navigate_to_section). Returned as a list of ``types.Tool`` for
    ``GenerateContentConfig.tools``. Imported lazily so importing providers in
    the mock path never requires google-genai."""
    from google.genai import types

    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name='open_resume',
                    description=(
                        'Open the visitor-facing resume PDF in a new tab. Call this when the user asks to '
                        'see, open, download, or get the resume.'
                    ),
                    parameters=types.Schema(type=types.Type.OBJECT, properties={}),
                ),
                types.FunctionDeclaration(
                    name='open_contact_form',
                    description=(
                        'Open the contact dialog, optionally pre-filling subject and message. Call this when '
                        "the user wants to get in touch, hire, send a message, or reach out."
                    ),
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            'subject': types.Schema(
                                type=types.Type.STRING,
                                description='Short subject line (e.g. "Architecture role").',
                            ),
                            'message': types.Schema(
                                type=types.Type.STRING,
                                description='Pre-filled message body in the visitor\'s voice.',
                            ),
                        },
                    ),
                ),
            ],
        ),
    ]


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
    messages = [Msg(role="human", content=knowledge_xml), *compacted]
    return {
        "messages": messages,
        "faq_match": context.get("faq_match"),
    }


def _mock_llm_reply(messages: list[Msg]) -> Msg:
    last = ''
    knowledge = ''
    for m in reversed(messages):
        if getattr(m, 'type', None) == 'human':
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
    return Msg(role="ai", content=text)


class _MockChain:
    """Duck-typed stand-in for the routing chain when CHAT_PROVIDER=mock.

    Exposes the same ``.ainvoke`` / ``.astream`` surface the FastAPI handlers
    call: build the injected ``Msg`` list with the deterministic retriever, then
    return the mock reply. Streaming yields the single final ``Msg`` (main's
    ``_chat_stream`` treats a non-chunk yield as the source of truth)."""

    __slots__ = ('_inject',)

    def __init__(self, inject: Any) -> None:
        self._inject = inject

    def _reply(self, inp: dict[str, Any]) -> Msg:
        injected = self._inject(inp)
        return _mock_llm_reply(injected["messages"])

    async def ainvoke(self, inp: dict[str, Any], config: Any | None = None) -> Msg:
        return self._reply(inp)

    async def astream(
        self, inp: dict[str, Any], config: Any | None = None
    ) -> AsyncIterator[Msg]:
        yield self._reply(inp)


def build_llm_runnable(
    provider: str,
    system_prompt: str,
    knowledge_pack: dict[str, Any],
) -> tuple[Any, str]:
    """Return (chain, model_id). Chain input: {"messages": list[Msg]}."""
    provider = provider.lower()
    model_id = _model_id_for_provider(provider)
    timeout_s = _get_timeout_seconds(provider)

    def inject(inp: dict[str, Any]) -> dict[str, Any]:
        return _inject_retrieved(knowledge_pack, inp)

    if provider == "mock":
        return _MockChain(inject), model_id

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
            inject,
            system_prompt,
            primary_id,
            fallback_id,
            key,
            timeout_s,
            tools=chat_tools(),
        )
        return chain, primary_id

    raise ValueError(f"Unknown CHAT_PROVIDER: {provider}")


def get_provider_and_model() -> tuple[str, str]:
    p = _get_provider_name()
    return p, _model_id_for_provider(p)
