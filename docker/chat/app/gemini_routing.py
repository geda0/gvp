"""Gemini: primary model with automatic fallback when the provider rate-limits."""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

logger = logging.getLogger(__name__)


def _max_output_tokens() -> int:
    try:
        val = int((os.environ.get('GEMINI_MAX_OUTPUT_TOKENS') or '896').strip())
    except ValueError:
        val = 896
    return max(256, min(val, 2048))


class GeminiRoutingChain:
    """Shared inject|prompt prefix; swap ChatGoogleGenerativeAI by model id per attempt."""

    __slots__ = (
        'prefix',
        'primary_id',
        'fallback_id',
        'key',
        'timeout',
        'last_model_id',
        'tools',
    )

    def __init__(
        self,
        prefix: Any,
        primary_id: str,
        fallback_id: str,
        key: str,
        timeout: float,
        tools: list[Any] | None = None,
    ) -> None:
        self.prefix = prefix
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
        from langchain_google_genai import ChatGoogleGenerativeAI

        llm = ChatGoogleGenerativeAI(
            model=model_id,
            google_api_key=self.key,
            temperature=0.2,
            timeout=self.timeout,
            max_output_tokens=_max_output_tokens(),
        )
        if self.tools:
            llm = llm.bind_tools(self.tools)
        return self.prefix | llm

    async def ainvoke(self, inp: dict[str, Any], config: Any | None = None) -> Any:
        from app.gemini_limit_state import note_primary_rate_limited
        from app.upstream_errors import is_upstream_rate_limit

        order = self._model_order()
        last_exc: BaseException | None = None
        for idx, model_id in enumerate(order):
            chain = self._build_chain(model_id)
            try:
                out = await chain.ainvoke(inp, config=config)
                self.last_model_id = model_id
                return out
            except Exception as e:
                last_exc = e
                if not is_upstream_rate_limit(e):
                    raise
                if model_id == self.primary_id:
                    note_primary_rate_limited()
                logger.warning(
                    'gemini rate_limited model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if idx == len(order) - 1:
                    raise
        assert last_exc is not None
        raise last_exc

    async def astream(
        self,
        inp: dict[str, Any],
        config: Any | None = None,
    ) -> AsyncIterator[Any]:
        """Stream chunks from the primary model; fall back only if the FIRST chunk
        fails with a rate limit. Once any chunk is yielded we're committed to the
        current model — mid-stream errors propagate."""
        from app.gemini_limit_state import note_primary_rate_limited
        from app.upstream_errors import is_upstream_rate_limit

        order = self._model_order()
        last_exc: BaseException | None = None
        for idx, model_id in enumerate(order):
            chain = self._build_chain(model_id)
            stream = chain.astream(inp, config=config)
            iterator = stream.__aiter__()
            first_chunk: Any = None
            try:
                first_chunk = await iterator.__anext__()
            except StopAsyncIteration:
                self.last_model_id = model_id
                return
            except Exception as e:
                last_exc = e
                if not is_upstream_rate_limit(e):
                    raise
                if model_id == self.primary_id:
                    note_primary_rate_limited()
                logger.warning(
                    'gemini stream rate_limited model=%s remaining_attempts=%s',
                    model_id,
                    len(order) - idx - 1,
                )
                if idx == len(order) - 1:
                    raise
                continue

            self.last_model_id = model_id
            yield first_chunk
            async for chunk in iterator:
                yield chunk
            return

        assert last_exc is not None
        raise last_exc
