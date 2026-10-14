"""Gemini (google-genai SDK): primary model with automatic fallback on rate limit.

``GeminiRoutingChain`` keeps the same duck-typed ``.ainvoke`` / ``.astream``
surface the FastAPI handlers call. ``_build_chain(model_id)`` returns a thin
adapter over the google-genai async client that:

  * runs the injected-retrieval callable to get the ``Msg`` list + faq match,
  * converts ``Msg`` → ``types.Content`` (human→user, ai→model, system folded
    into ``config.system_instruction``; Gemini has no per-turn system role),
  * calls ``client.aio.models.generate_content_stream`` / ``generate_content``,
  * yields ``MsgChunk(text, tool_calls)`` / returns ``Msg(role="ai", ...)``.

The commit-on-first-chunk fallback (project invariant #9) lives in ``astream``:
fall back to the secondary model only if the FIRST chunk raises an upstream rate
limit; once any chunk has yielded we are committed and mid-stream errors
propagate.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any, AsyncIterator

from app.messages import Msg, MsgChunk

logger = logging.getLogger(__name__)

_clients_lock = threading.Lock()
_text_clients: dict[str, Any] = {}


def _first_chunk_timeout(total_timeout: float) -> float:
    """Per-attempt budget for a NON-final model's first chunk. A primary that
    produces no first token within this window is abandoned in favour of the
    fallback — well inside the overall request deadline so the fallback still has
    room to answer. Configurable via GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS; capped at
    60% of the total budget so it never starves the fallback."""
    raw = os.environ.get('GEMINI_FIRST_CHUNK_TIMEOUT_SECONDS')
    try:
        val = float(raw) if raw else 12.0
    except ValueError:
        val = 12.0
    return max(0.1, min(val, total_timeout * 0.6))


async def _aclose_quietly(iterator: Any) -> None:
    """Close an abandoned async iterator (e.g. a stalled primary stream) without
    letting teardown errors mask the fallback."""
    aclose = getattr(iterator, 'aclose', None)
    if aclose is None:
        return
    try:
        await aclose()
    except Exception:  # pragma: no cover - best-effort cleanup
        pass


def _max_output_tokens() -> int:
    try:
        val = int((os.environ.get('GEMINI_MAX_OUTPUT_TOKENS') or '896').strip())
    except ValueError:
        val = 896
    return max(256, min(val, 2048))


def _text_client_singleton(api_key: str) -> Any:
    """Cache one google-genai client per api_key (the DEFAULT API — NOT Live's
    v1alpha HttpOptions). Mirrors live_gemini's client-singleton idiom but with a
    separate client so the text path uses the standard generateContent endpoint."""
    from google import genai

    key = (api_key or '').strip()
    if not key:
        raise RuntimeError('GEMINI_API_KEY is not set')
    with _clients_lock:
        client = _text_clients.get(key)
        if client is None:
            client = genai.Client(api_key=key)
            _text_clients[key] = client
        return client


def _tool_calls_from_function_calls(function_calls: Any) -> list[dict[str, Any]]:
    """Map google-genai ``list[types.FunctionCall]`` → internal ``tool_calls``
    (``[{"name", "args", "id"}]``). main._actions_from_result /
    _tool_calls_from_result already read this shape. ``None`` args become ``{}``;
    ``None`` id becomes ``None``."""
    out: list[dict[str, Any]] = []
    for fc in function_calls or []:
        name = getattr(fc, 'name', None)
        if not name:
            continue
        args = getattr(fc, 'args', None)
        out.append(
            {
                'name': str(name),
                'args': dict(args) if isinstance(args, dict) else {},
                'id': getattr(fc, 'id', None) or None,
            }
        )
    return out


def _to_contents(messages: list[Any]) -> tuple[list[Any], str]:
    """Convert a ``Msg`` list → (``list[types.Content]``, system_instruction str).

    human→``role="user"``, ai→``role="model"``; system messages are folded out of
    the turn list and joined into the system instruction (Gemini has no per-turn
    system role)."""
    from google.genai import types

    contents: list[Any] = []
    system_parts: list[str] = []
    for m in messages:
        role = getattr(m, 'type', None) or getattr(m, 'role', None)
        content = str(getattr(m, 'content', '') or '')
        if role == 'system':
            if content:
                system_parts.append(content)
            continue
        api_role = 'model' if role == 'ai' else 'user'
        contents.append(
            types.Content(role=api_role, parts=[types.Part.from_text(text=content)])
        )
    return contents, '\n\n'.join(system_parts)


def usage_telemetry(usage: Any) -> dict[str, Any] | None:
    """Cache-effectiveness numbers from a google-genai ``usage_metadata``, or None.

    The one number that matters is ``cached_pct``: the share of the prompt Gemini served
    from its implicit cache. Cached input tokens do NOT count against the free tier's
    16,000-input-tokens-per-minute-per-model quota (measured 2026-10-13), so that share
    IS the throughput headroom — and it depends on a byte-identical prefix that an
    innocent content edit can break. ``cached_pct`` quietly going to 0 is the only signal
    that happened, since answers stay correct and latency barely moves.

    ``billable_prompt_tokens`` is what still counts, i.e. 16000 / that ~= turns per
    minute before a 429.

    Returns None rather than raising on anything unusable: this feeds a log line, and no
    turn may ever fail because its telemetry could not be computed.
    """
    prompt = getattr(usage, 'prompt_token_count', None)
    if not isinstance(prompt, int) or isinstance(prompt, bool) or prompt <= 0:
        return None

    def _count(name: str) -> int:
        value = getattr(usage, name, None)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            return 0
        return value

    # A cold call reports None here. That is a real zero, not missing data — reporting it
    # as 0 keeps "cache is cold" distinguishable from "no telemetry" in the log.
    cached = min(_count('cached_content_token_count'), prompt)
    return {
        'prompt_tokens': prompt,
        'cached_tokens': cached,
        'cached_pct': round(100.0 * cached / prompt),
        'billable_prompt_tokens': prompt - cached,
        'output_tokens': _count('candidates_token_count'),
    }


def _log_usage(model_id: str, usage: Any) -> None:
    """Emit the per-turn usage line. PER MODEL on purpose: the cache is per model, so a
    fallback to the secondary always starts cold, and an aggregate would hide that."""
    try:
        stats = usage_telemetry(usage)
        if stats is None:
            return
        logger.info(
            'gemini usage model=%s prompt=%s cached=%s cached_pct=%s billable=%s output=%s',
            model_id,
            stats['prompt_tokens'],
            stats['cached_tokens'],
            stats['cached_pct'],
            stats['billable_prompt_tokens'],
            stats['output_tokens'],
        )
    except Exception:  # noqa: BLE001 - telemetry must never break a turn
        logger.debug('usage telemetry failed for model=%s', model_id, exc_info=True)


class _GeminiAdapter:
    """Per-model google-genai adapter exposing ``.ainvoke`` / ``.astream``."""

    __slots__ = ('_client', '_model_id', '_inject', '_system_prompt', '_tools')

    def __init__(
        self,
        client: Any,
        model_id: str,
        inject: Any,
        system_prompt: str,
        tools: list[Any],
    ) -> None:
        self._client = client
        self._model_id = model_id
        self._inject = inject
        self._system_prompt = system_prompt
        self._tools = tools

    def _prepare(self, inp: dict[str, Any]) -> tuple[list[Any], Any]:
        from google.genai import types

        injected = self._inject(inp) if self._inject is not None else inp
        messages = list(injected.get('messages', []))
        contents, folded_system = _to_contents(messages)
        system_instruction = self._system_prompt or ''
        if folded_system:
            system_instruction = (
                f'{system_instruction}\n\n{folded_system}' if system_instruction else folded_system
            )
        config = types.GenerateContentConfig(
            temperature=0.2,
            max_output_tokens=_max_output_tokens(),
            system_instruction=system_instruction or None,
            tools=self._tools or None,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        return contents, config

    async def ainvoke(self, inp: dict[str, Any], config: Any | None = None) -> Msg:
        del config
        contents, gen_config = self._prepare(inp)
        resp = await self._client.aio.models.generate_content(
            model=self._model_id,
            contents=contents,
            config=gen_config,
        )
        _log_usage(self._model_id, getattr(resp, 'usage_metadata', None))
        tool_calls = _tool_calls_from_function_calls(getattr(resp, 'function_calls', None))
        return Msg(
            role='ai',
            content=resp.text or '',
            tool_calls=tool_calls or None,
        )

    async def astream(
        self, inp: dict[str, Any], config: Any | None = None
    ) -> AsyncIterator[MsgChunk]:
        del config
        contents, gen_config = self._prepare(inp)
        stream = await self._client.aio.models.generate_content_stream(
            model=self._model_id,
            contents=contents,
            config=gen_config,
        )
        # Risk seam #1: function calls can arrive in empty-text chunks. The SDK
        # surfaces the *complete* call on ``chunk.function_calls`` once it's
        # assembled (will_continue partials are not exposed here), so emitting
        # them per chunk and collecting in main's accumulator neither drops nor
        # duplicates a call. chunk.text may be "" for those chunks — fine.
        # Usage arrives on a LATE chunk (normally the last), so keep the newest one seen
        # and log once the stream closes. Streaming is the path prod actually serves, so
        # omitting it here would leave the real traffic unmeasured.
        last_usage: Any = None
        async for chunk in stream:
            chunk_usage = getattr(chunk, 'usage_metadata', None)
            if chunk_usage is not None:
                last_usage = chunk_usage
            text = getattr(chunk, 'text', None) or ''
            tool_calls = _tool_calls_from_function_calls(
                getattr(chunk, 'function_calls', None)
            )
            yield MsgChunk(text=text, tool_calls=tool_calls or None)
        _log_usage(self._model_id, last_usage)


class GeminiRoutingChain:
    """Inject + system prompt shared across attempts; swap the google-genai model
    by id per attempt with a transparent rate-limit fallback."""

    __slots__ = (
        'inject',
        'system_prompt',
        'primary_id',
        'fallback_id',
        'key',
        'timeout',
        'last_model_id',
        'tools',
    )

    def __init__(
        self,
        inject: Any,
        system_prompt: str,
        primary_id: str,
        fallback_id: str,
        key: str,
        timeout: float,
        tools: list[Any] | None = None,
    ) -> None:
        self.inject = inject
        self.system_prompt = system_prompt
        self.primary_id = primary_id
        self.fallback_id = fallback_id
        self.key = key
        self.timeout = timeout
        self.last_model_id = primary_id
        self.tools = list(tools or [])

    def _model_order(self) -> list[str]:
        from app.gemini_limit_state import prefer_fallback_first

        if prefer_fallback_first():
            return [self.fallback_id, self.primary_id]
        return [self.primary_id, self.fallback_id]

    def _build_chain(self, model_id: str) -> Any:
        client = _text_client_singleton(self.key)
        return _GeminiAdapter(
            client,
            model_id,
            self.inject,
            self.system_prompt,
            self.tools,
        )

    async def ainvoke(self, inp: dict[str, Any], config: Any | None = None) -> Any:
        from app.alerts import fire_alert
        from app.gemini_limit_state import (
            note_primary_rate_limited,
            note_primary_timed_out,
        )
        from app.upstream_errors import (
            is_upstream_rate_limit,
            is_upstream_retryable,
        )

        order = self._model_order()
        last_exc: BaseException | None = None
        for idx, model_id in enumerate(order):
            is_last = idx == len(order) - 1
            chain = self._build_chain(model_id)
            try:
                if is_last:
                    out = await chain.ainvoke(inp, config=config)
                else:
                    out = await asyncio.wait_for(
                        chain.ainvoke(inp, config=config),
                        timeout=_first_chunk_timeout(self.timeout),
                    )
                self.last_model_id = model_id
                return out
            except asyncio.TimeoutError as e:
                last_exc = e
                if model_id == self.primary_id:
                    note_primary_timed_out()
                logger.warning(
                    'gemini timeout model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if is_last:
                    fire_alert(
                        'chat_upstream_unavailable',
                        f'all chat models failed (last={model_id}: timeout)',
                    )
                    raise
                fire_alert(
                    'chat_primary_timeout',
                    f'{model_id} timed out; switching to {self.fallback_id}',
                )
            except Exception as e:
                last_exc = e
                if not is_upstream_retryable(e):
                    fire_alert(
                        'chat_model_error',
                        f'{model_id} errored: {type(e).__name__}',
                        detail=str(e)[:300],
                    )
                    raise
                if model_id == self.primary_id and is_upstream_rate_limit(e):
                    note_primary_rate_limited()
                logger.warning(
                    'gemini rate_limited model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if is_last:
                    fire_alert(
                        'chat_upstream_unavailable',
                        f'all chat models failed (last={model_id}: rate-limited)',
                    )
                    raise
                fire_alert(
                    'chat_primary_rate_limit',
                    f'{model_id} rate-limited; switching to {self.fallback_id}',
                )
        assert last_exc is not None
        raise last_exc

    async def astream(
        self,
        inp: dict[str, Any],
        config: Any | None = None,
    ) -> AsyncIterator[Any]:
        """Stream chunks from the primary model; fall back to the secondary if the
        FIRST chunk rate-limits OR fails to arrive within the per-attempt budget (a
        stalled/too-slow primary). Once any chunk is yielded we're committed to the
        current model — mid-stream errors propagate."""
        from app.alerts import fire_alert
        from app.gemini_limit_state import (
            note_primary_rate_limited,
            note_primary_timed_out,
        )
        from app.upstream_errors import (
            is_upstream_rate_limit,
            is_upstream_retryable,
        )

        order = self._model_order()
        last_exc: BaseException | None = None
        for idx, model_id in enumerate(order):
            is_last = idx == len(order) - 1
            chain = self._build_chain(model_id)
            stream = chain.astream(inp, config=config)
            iterator = stream.__aiter__()
            first_chunk: Any = None
            try:
                if is_last:
                    first_chunk = await iterator.__anext__()
                else:
                    first_chunk = await asyncio.wait_for(
                        iterator.__anext__(),
                        timeout=_first_chunk_timeout(self.timeout),
                    )
            except StopAsyncIteration:
                self.last_model_id = model_id
                return
            except asyncio.TimeoutError as e:
                last_exc = e
                await _aclose_quietly(iterator)
                if model_id == self.primary_id:
                    note_primary_timed_out()
                logger.warning(
                    'gemini stream first_chunk_timeout model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if is_last:
                    fire_alert(
                        'chat_upstream_unavailable',
                        f'all chat models failed (last={model_id}: first-chunk timeout)',
                    )
                    raise
                fire_alert(
                    'chat_primary_timeout',
                    f'{model_id} stalled past first-chunk budget; switching to {self.fallback_id}',
                )
                continue
            except Exception as e:
                last_exc = e
                if not is_upstream_retryable(e):
                    fire_alert(
                        'chat_model_error',
                        f'{model_id} errored: {type(e).__name__}',
                        detail=str(e)[:300],
                    )
                    raise
                if model_id == self.primary_id and is_upstream_rate_limit(e):
                    note_primary_rate_limited()
                logger.warning(
                    'gemini stream rate_limited model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if is_last:
                    fire_alert(
                        'chat_upstream_unavailable',
                        f'all chat models failed (last={model_id}: rate-limited)',
                    )
                    raise
                fire_alert(
                    'chat_primary_rate_limit',
                    f'{model_id} rate-limited; switching to {self.fallback_id}',
                )
                continue

            self.last_model_id = model_id
            yield first_chunk
            async for chunk in iterator:
                yield chunk
            return

        assert last_exc is not None
        raise last_exc
