"""Live relay: handshake must not race ahead of the browser reader task."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.live_relay import relay_browser_to_google


@pytest.mark.asyncio
async def test_relay_sends_handshake_after_reader_ready() -> None:
    """setupComplete can arrive immediately; reader task must be listening before upstream.send(setup)."""
    order: list[str] = []
    handshake = json.dumps({'setup': {'model': 'models/test'}})
    orig_set = asyncio.Event.set

    def tracking_set(self: asyncio.Event) -> None:
        order.append('reader_ready')
        orig_set(self)

    class FakeUpstream:
        def __init__(self) -> None:
            self.sent: list[str] = []

        async def send(self, data: str) -> None:
            order.append('handshake')
            self.sent.append(data)

        async def close(self) -> None:
            pass

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    fake_upstream = FakeUpstream()

    browser_ws = MagicMock()
    browser_ws.receive = AsyncMock(side_effect=[{'type': 'websocket.disconnect'}])
    browser_ws.send_text = AsyncMock()
    browser_ws.send_bytes = AsyncMock()
    browser_ws.close = AsyncMock()

    class FakeCm:
        async def __aenter__(self):
            order.append('upstream_connected')
            return fake_upstream

        async def __aexit__(self, *_exc):
            return None

    captured_connect: dict = {}

    def capture_connect(*args, **kwargs):
        captured_connect.update(kwargs)
        return FakeCm()

    with (
        patch('app.live_relay.websockets.connect', side_effect=capture_connect),
        patch.object(asyncio.Event, 'set', tracking_set),
    ):
        await relay_browser_to_google(
            browser_ws,
            token_name='auth_tokens/test',
            handshake_json=handshake,
        )

    assert order.index('upstream_connected') < order.index('reader_ready')
    assert order.index('reader_ready') < order.index('handshake')
    assert fake_upstream.sent == [handshake]
    assert captured_connect.get('open_timeout') == 25.0
    assert captured_connect.get('ping_interval') == 20.0
