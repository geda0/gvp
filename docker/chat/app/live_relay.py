"""Relay browser Live WebSocket to Google with Authorization: Token (query param is insufficient)."""

from __future__ import annotations

import asyncio
import logging

import websockets
from fastapi import WebSocket
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

GOOGLE_LIVE_CONSTRAINED_URI = (
    'wss://generativelanguage.googleapis.com/ws/'
    'google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'
)


async def relay_browser_to_google(
    browser_ws: WebSocket,
    *,
    token_name: str,
    handshake_json: str,
) -> None:
    headers = [('Authorization', f'Token {token_name}')]
    try:
        async with websockets.connect(
            GOOGLE_LIVE_CONSTRAINED_URI,
            additional_headers=headers,
            max_size=None,
        ) as upstream:
            await upstream.send(handshake_json)

            async def browser_to_upstream() -> None:
                try:
                    while True:
                        msg = await browser_ws.receive()
                        if msg['type'] == 'websocket.disconnect':
                            break
                        if msg['type'] != 'websocket.receive':
                            continue
                        b = msg.get('bytes')
                        t = msg.get('text')
                        if b is not None:
                            await upstream.send(b)
                        elif t is not None:
                            await upstream.send(t)
                except Exception as exc:
                    logger.debug('relay browser_to_upstream end: %s', exc)
                try:
                    await upstream.close()
                except Exception:
                    pass

            async def upstream_to_browser() -> None:
                try:
                    async for packet in upstream:
                        if isinstance(packet, str):
                            await browser_ws.send_text(packet)
                        else:
                            await browser_ws.send_bytes(packet)
                except ConnectionClosed:
                    pass
                except Exception as exc:
                    logger.debug('relay upstream_to_browser end: %s', exc)

            b_task = asyncio.create_task(browser_to_upstream())
            u_task = asyncio.create_task(upstream_to_browser())
            done, pending = await asyncio.wait(
                {b_task, u_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for p in pending:
                p.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    except Exception as exc:
        logger.warning('live relay upstream failed: %s', exc)
        try:
            await browser_ws.close(code=1011, reason='live relay failed')
        except Exception:
            pass
        return

    try:
        await browser_ws.close()
    except Exception:
        pass
