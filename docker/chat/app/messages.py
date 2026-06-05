"""Dependency-free internal message value types (replaces langchain_core.messages).

The text-chat path used to flow LangChain ``HumanMessage`` / ``AIMessage`` /
``AIMessageChunk`` objects between the FastAPI handlers, the provider chains, and
the deterministic retriever. Those carried two things this codebase actually
relied on:

  * ``.content`` — a string (the reply / prompt text), and
  * ``.type`` — ``"human"`` / ``"ai"`` / ``"system"`` (used by ``getattr(m, "type")``
    checks in retrieval + the streaming aggregation), and
  * ``.tool_calls`` — a list of ``{"name", "args", "id"}`` dicts on AI messages.

``Msg`` reproduces exactly that surface with a frozen dataclass and no third-party
dependency. ``MsgChunk`` is the streaming delta. ``accumulate`` / ``_Acc`` replace
``AIMessageChunk.__add__`` (the ``aggregated = aggregated + chunk`` fold in
``main._chat_stream``): concatenate ``text`` and collect ``tool_calls`` across
chunks into a single final ``Msg`` — without dropping or duplicating the reply or
the tool calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Role = Literal["human", "ai", "system"]


@dataclass(frozen=True)
class Msg:
    """A single chat message. Mirrors the LangChain ``BaseMessage`` surface this
    codebase used: ``.content`` (str), ``.type`` (== role), and ``.tool_calls``
    (list of ``{"name", "args", "id"}`` dicts; empty for non-AI messages)."""

    role: Role
    content: str = ""
    tool_calls: list[dict] | None = None

    @property
    def type(self) -> str:
        """LangChain compatibility: existing ``getattr(m, "type") == "human"``
        checks read this. Returns the role verbatim."""
        return self.role


@dataclass(frozen=True)
class MsgChunk:
    """A streamed delta. ``text`` is the incremental reply text (may be ``""`` for
    function-call / thought chunks). ``tool_calls`` carries any *complete* tool
    calls finalized on this chunk (the adapter only emits a call once, never the
    ``will_continue`` partials), so the accumulator can collect without dedup."""

    text: str = ""
    tool_calls: list[dict] | None = None


@dataclass
class _Acc:
    """Mutable streaming accumulator. Concatenates chunk ``text`` and appends
    chunk ``tool_calls`` in arrival order, then finalizes to a single ``Msg``."""

    text: str = ""
    tool_calls: list[dict] = field(default_factory=list)

    def add(self, chunk: MsgChunk) -> None:
        if chunk.text:
            self.text += chunk.text
        for call in chunk.tool_calls or []:
            self.tool_calls.append(call)

    def finalize(self) -> Msg:
        return Msg(
            role="ai",
            content=self.text,
            tool_calls=list(self.tool_calls) if self.tool_calls else None,
        )


def accumulate(chunks: list[MsgChunk]) -> Msg:
    """Fold a list of streamed ``MsgChunk`` deltas into one ``Msg`` (ai role).

    Replaces the ``AIMessageChunk.__add__`` fold: text is concatenated in order
    and tool calls are collected, so the resulting message is what
    ``main._reply_text_from_result`` / ``_actions_from_result`` read once at the
    end of the stream.
    """
    acc = _Acc()
    for chunk in chunks:
        acc.add(chunk)
    return acc.finalize()
