"""LLM chains by CHAT_PROVIDER (mock + Gemini via the google-genai SDK)."""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

from app.knowledge_context import build_context, compact_history, serialize_context_xml
from app.messages import Msg
from app.secret_resolver import resolve_gemini_key_into_env

logger = logging.getLogger(__name__)

# Bootstrap the Gemini key from Secrets Manager (no-op unless GEMINI_API_KEY_SECRET_ARN is
# set) BEFORE anything reads it. Deliberately at import time, and this is the load-bearing
# detail: the key is read in six places across four modules, two of them on SECURITY_GLOB
# (main.py, live_gemini.py). Resolving into os.environ here means every one of those read
# sites works unchanged and the gated files are not touched at all. main.py imports
# app.providers at module scope and reads the key only inside functions, so the ordering
# holds. Never raises — see the availability note in app/secret_resolver.py.
resolve_gemini_key_into_env()


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
    """Function-call declarations for the Gemini text path: open_resume,
    open_contact_form, navigate_to_section and the project tools - the same set Live
    declares - plus start_tour, which is text-only (Track C item 6: the page runs the
    tour; voice parity is a bonus, not required). The enum must stay equal to
    live_gemini.py's; see docker/chat/tests/test_guide_tool_contract.py.
    Returned as a list of ``types.Tool`` for ``GenerateContentConfig.tools``.
    Imported lazily so importing providers in the mock path never requires
    google-genai."""
    from google.genai import types

    from app.project_refs import PROJECT_IDS

    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name='open_resume',
                    description=(
                        'Download the resume PDF file. Call this ONLY when the visitor explicitly asks to '
                        'download or save the PDF/file (e.g. "download your resume", "send me the PDF", "get the '
                        'resume file"). Do NOT call it for "see", "view", "show me", or "where is" the resume, '
                        'nor for any question about experience or background — for ALL of those call '
                        'navigate_to_section("portfolio") so they see the work in context (the resume link lives there).'
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
                types.FunctionDeclaration(
                    name='start_tour',
                    description=(
                        'Start a guided tour of THIS site: the page moves through the work one stop at a time, '
                        'with a short line at each stop, and the visitor taps to go on. Call this when they say '
                        '"show me around", "give me a tour", "walk me through the site" or similar. Do not '
                        'narrate the tour yourself - one short sentence that it is starting is enough.'
                    ),
                    parameters=types.Schema(type=types.Type.OBJECT, properties={}),
                ),
                types.FunctionDeclaration(
                    name='navigate_to_section',
                    description=(
                        'Scroll the visitor to a top-level section of THIS site so they can see it - the page '
                        'moves. Call this when they ask to go to or see the work, projects, experience, '
                        'portfolio, or labs - guide them to the section instead of dumping a link or the resume. '
                        'For a whole-site tour use start_tour instead.'
                    ),
                    parameters=types.Schema(
                        type=types.Type.OBJECT,
                        properties={
                            'section': types.Schema(
                                type=types.Type.STRING,
                                enum=['home', 'portfolio', 'labs'],
                                description='Section id: home, portfolio (professional work), or labs (personal builds).',
                            ),
                        },
                        required=['section'],
                    ),
                ),
                *(
                    [
                        types.FunctionDeclaration(
                            name='open_project',
                            description=(
                                "Open one project's detail card on THIS site so the visitor can see it while you talk about it. Call this when they ask about, or want to see, a specific project or role (e.g. Team Tactics, Apptio, JumpCloud). Use the project id from the enum."
                            ),
                            parameters=types.Schema(
                                type=types.Type.OBJECT,
                                properties={
                                    'project': types.Schema(
                                        type=types.Type.STRING,
                                        # ONE tuple for text and voice (app/project_refs.py, ADR-0017 §3.1):
                                        # equal by construction, not by a test written after they drift.
                                        enum=list(PROJECT_IDS),
                                        description='Project id.',
                                    ),
                                },
                                required=['project'],
                            ),
                        ),
                        types.FunctionDeclaration(
                            name='close_project',
                            description=(
                                'Close the project card that is open, returning the visitor to the page behind it. Call this when they are done with the project or ask to go back.'
                            ),
                            parameters=types.Schema(type=types.Type.OBJECT, properties={}),
                        ),
                    ]
                    # An empty enum is rejected by Gemini, so a missing pack omits the tools instead.
                    if PROJECT_IDS
                    else []
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
    # M4 (ADR-0017 §4.1): the visitor's open project, pinned into <relevant_projects> by
    # explicit parameter. Read HERE so the real and the mock chain thread it identically.
    pinned = inp.get("pinnedProjectId")
    context = build_context(
        last, history_text, knowledge_pack,
        pinned_project_id=pinned if isinstance(pinned, str) else None,
    )
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
        # ADR-0025 #2: a key that failed to resolve at cold start may recover here (cached
        # when resolved; retried at most once per GEMINI_KEY_RETRY_SECONDS when it failed).
        resolve_gemini_key_into_env()
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
