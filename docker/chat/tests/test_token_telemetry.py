"""Is the implicit cache actually hitting in production, or do we only hope it is?

WHY THIS EXISTS — found while verifying `34a7283` on stage, 2026-10-14.

`34a7283` reordered the knowledge blob so Gemini's implicit cache can match an identical
prefix, which is what lifts the free tier's 16,000-input-tokens-per-minute ceiling. The
reordering was verified by calling the API directly from a laptop:

    q1: prompt=6619  cached=None
    q2: prompt=6794  cached=4075
    q3: prompt=6423  cached=4074

But the DEPLOYED host logs nothing about tokens — no `usage_metadata`, no
`cached_content_token_count`, nowhere in `docker/chat/app/`. So after shipping the fix
there was no way to confirm it was working in prod; the evidence came from a laptop, not
from the thing serving visitors. A performance fix you cannot observe is a performance fix
you cannot defend, and the cache silently ceasing to hit looks exactly like nothing at all
— answers stay correct, latency barely moves, and only the 429 rate drifts back up.

Two further reasons this specific number matters:
  * the cache is PER MODEL, so every fallback to `gemma-4-26b-a4b-it` starts cold. That
    was measured on stage (`rate_limited model=gemma-4-26b-a4b-it` after flash-lite
    timeouts) and is invisible without per-model usage;
  * the prefix sits around 4,884 tokens against a 4,096 minimum that the published docs
    disagree about (1,024 / 2,048 / 4,096 / 6,144). A content edit to the bio could drop
    it under the floor, and `cached=0` is the only signal that happened.

The telemetry goes in `gemini_routing.py`, not `main.py`, deliberately: main.py is on
SECURITY_GLOB (gated in every phase including `off`), and the response object with the
usage on it is already in hand here.

Telemetry must never break a turn, so the absent/garbage cases are pinned as hard as the
happy path.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

from app.gemini_routing import _GeminiAdapter, usage_telemetry
from app.messages import Msg


def _usage(prompt=None, cached=None, candidates=None, total=None):
    """Shape the google-genai SDK hands back on `response.usage_metadata`."""
    return SimpleNamespace(
        prompt_token_count=prompt,
        cached_content_token_count=cached,
        candidates_token_count=candidates,
        total_token_count=total,
    )


# --------------------------------------------------------------------------- pure part


def test_usage_telemetry_reports_the_cache_hit_share():
    """The derived number we actually care about: how much of the prompt was free."""
    out = usage_telemetry(_usage(prompt=6794, cached=4075, candidates=120, total=6914))

    assert out is not None, 'a populated usage object must produce telemetry'
    assert out['prompt_tokens'] == 6794
    assert out['cached_tokens'] == 4075
    # 4075/6794 = 59.98% — the share of the prompt served from cache, which is the
    # single number that says whether the prefix fix is still working.
    assert 59 <= out['cached_pct'] <= 61, (
        f'cached_pct came out {out.get("cached_pct")}, expected ~60 for 4075 of 6794'
    )
    # And what still counts against the 16,000/min quota.
    assert out['billable_prompt_tokens'] == 6794 - 4075


def test_a_cold_call_reports_zero_cached_not_none():
    """First call of a prefix reports `cached=None`; that is zero, not missing data.

    If this leaked through as None the log line would read `cached=None` and a reader
    could not tell a cold cache from absent telemetry.
    """
    out = usage_telemetry(_usage(prompt=6619, cached=None, candidates=80, total=6699))

    assert out is not None
    assert out['cached_tokens'] == 0
    assert out['cached_pct'] == 0
    assert out['billable_prompt_tokens'] == 6619


def test_telemetry_never_raises_on_junk_or_absent_usage():
    """Telemetry is observability, never a failure path. A turn must not die for it."""
    for bad in (None, SimpleNamespace(), object(), 'not-a-usage-object', 0):
        assert usage_telemetry(bad) is None, f'{bad!r} should yield None, not raise'

    # Present but unusable: a prompt count of 0 cannot produce a percentage.
    zero = usage_telemetry(_usage(prompt=0, cached=0))
    assert zero is None or zero.get('cached_pct') == 0, (
        'a zero prompt count must not divide by zero'
    )


# ------------------------------------------------------------------- wiring, non-stream


class _FakeModels:
    def __init__(self, resp):
        self._resp = resp

    async def generate_content(self, **_kwargs):
        return self._resp

    async def generate_content_stream(self, **_kwargs):
        async def gen():
            for chunk in self._resp:
                yield chunk

        return gen()


def _fake_client(resp):
    return SimpleNamespace(aio=SimpleNamespace(models=_FakeModels(resp)))


def _adapter(resp):
    return _GeminiAdapter(
        client=_fake_client(resp),
        model_id='gemini-3.1-flash-lite',
        inject=None,
        system_prompt='sys',
        tools=[],
    )


def test_ainvoke_logs_the_usage_line(caplog):
    """The deployed host must SAY what the cache did, per model, per turn."""
    resp = SimpleNamespace(
        text='hello',
        function_calls=None,
        usage_metadata=_usage(prompt=6794, cached=4075, candidates=12, total=6806),
    )
    adapter = _adapter(resp)

    with caplog.at_level(logging.INFO, logger='app.gemini_routing'):
        out = asyncio.run(adapter.ainvoke({'messages': [Msg(role='human', content='hi')]}))

    assert isinstance(out, Msg) and out.content == 'hello', 'the reply must still come back'

    blob = ' '.join(r.getMessage() for r in caplog.records)
    for needle in ('6794', '4075', 'gemini-3.1-flash-lite'):
        assert needle in blob, (
            f'{needle!r} is absent from the logs, so cache effectiveness stays '
            f'unmeasurable on the deployed host. Logged: {blob!r}'
        )


def test_a_turn_still_succeeds_when_the_sdk_reports_no_usage(caplog):
    """Missing usage must cost us the telemetry, never the answer."""
    resp = SimpleNamespace(text='still fine', function_calls=None)  # no usage_metadata

    with caplog.at_level(logging.INFO, logger='app.gemini_routing'):
        out = asyncio.run(
            _adapter(resp).ainvoke({'messages': [Msg(role='human', content='hi')]})
        )

    assert out.content == 'still fine', (
        'a response without usage_metadata must still return its reply — telemetry is '
        'not a precondition for answering'
    )


# ----------------------------------------------------------------------- wiring, stream


def test_astream_logs_usage_from_the_streamed_chunks(caplog):
    """Streaming is the path prod actually serves, and usage arrives on a late chunk."""
    chunks = [
        SimpleNamespace(text='par', function_calls=None),
        SimpleNamespace(text='tial', function_calls=None),
        SimpleNamespace(
            text='',
            function_calls=None,
            usage_metadata=_usage(prompt=6423, cached=4074, candidates=30, total=6453),
        ),
    ]

    async def drain():
        return [c.text async for c in _adapter(chunks).astream({'messages': []})]

    with caplog.at_level(logging.INFO, logger='app.gemini_routing'):
        texts = asyncio.run(drain())

    assert ''.join(texts) == 'partial', 'every chunk must still reach the caller'

    blob = ' '.join(r.getMessage() for r in caplog.records)
    for needle in ('6423', '4074'):
        assert needle in blob, (
            f'{needle!r} is absent, so the STREAMING path — the one prod serves — reports '
            f'nothing about the cache. Logged: {blob!r}'
        )
