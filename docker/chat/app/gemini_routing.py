"""Gemini: primary model with automatic fallback when the provider rate-limits."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class GeminiRoutingChain:
    """Shared inject|prompt prefix; swap ChatGoogleGenerativeAI by model id per attempt."""

    __slots__ = ('prefix', 'primary_id', 'fallback_id', 'key', 'timeout', 'last_model_id')

    def __init__(
        self,
        prefix: Any,
        primary_id: str,
        fallback_id: str,
        key: str,
        timeout: float,
    ) -> None:
        self.prefix = prefix
        self.primary_id = primary_id
        self.fallback_id = fallback_id
        self.key = key
        self.timeout = timeout
        self.last_model_id = primary_id

    def _model_order(self) -> list[str]:
        from app.gemini_limit_state import prefer_fallback_first

        if prefer_fallback_first():
            return [self.fallback_id, self.primary_id]
        return [self.primary_id, self.fallback_id]

    async def ainvoke(self, inp: dict[str, Any], config: Any | None = None) -> Any:
        from langchain_google_genai import ChatGoogleGenerativeAI

        from app.gemini_limit_state import note_primary_rate_limited
        from app.upstream_errors import is_upstream_rate_limit

        order = self._model_order()
        last_exc: BaseException | None = None
        for idx, model_id in enumerate(order):
            llm = ChatGoogleGenerativeAI(
                model=model_id,
                google_api_key=self.key,
                temperature=0.2,
                timeout=self.timeout,
            )
            chain = self.prefix | llm
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
