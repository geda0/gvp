"""Relay browser Live WebSocket to Google using Authorization: Token.

Google documents ephemeral Live access with either an ``access_token`` query parameter or
``Authorization: Token`` on the WebSocket. Browsers cannot set custom headers on WebSocket,
so this relay runs on a WebSocket-capable server: the browser connects here, and this
module connects upstream with ``Authorization: Token`` for a single controlled path.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

import websockets
from fastapi import WebSocket
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

GOOGLE_LIVE_CONSTRAINED_URI = (
    'wss://generativelanguage.googleapis.com/ws/'
    'google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'
)

_UPSTREAM_OPEN_TIMEOUT = float(os.environ.get('CHAT_LIVE_RELAY_UPSTREAM_OPEN_SEC', '25'))
_UPSTREAM_PING_INTERVAL = float(os.environ.get('CHAT_LIVE_RELAY_PING_INTERVAL_SEC', '20'))
_UPSTREAM_PING_TIMEOUT = float(os.environ.get('CHAT_LIVE_RELAY_PING_TIMEOUT_SEC', '20'))


async def _notify_browser_relay_error(browser_ws: WebSocket, code: str, message: str) -> None:
    try:
        await browser_ws.send_text(
            json.dumps({'error': message, 'code': code}),
        )
    except Exception:
        pass


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
            open_timeout=_UPSTREAM_OPEN_TIMEOUT,
            ping_interval=_UPSTREAM_PING_INTERVAL,
            ping_timeout=_UPSTREAM_PING_TIMEOUT,
            close_timeout=10,
        ) as upstream:
            reader_ready = asyncio.Event()

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
                reader_ready.set()
                try:
                    async for packet in upstream:
                        if isinstance(packet, str):
                            await browser_ws.send_text(packet)
                        else:
                            await browser_ws.send_bytes(packet)
                except ConnectionClosed as exc:
                    reason = (getattr(exc, 'reason', None) or '')[:240]
                    logger.warning(
                        'live relay upstream closed code=%s reason=%s',
                        getattr(exc, 'code', None),
                        reason,
                    )
                except Exception as exc:
                    logger.debug('relay upstream_to_browser end: %s', exc)

            u_task = asyncio.create_task(upstream_to_browser())
            try:
                await asyncio.wait_for(reader_ready.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.error('live relay: browser reader task did not start')
                await _notify_browser_relay_error(
                    browser_ws,
                    'relay_reader_timeout',
                    'Voice relay failed to start',
                )
                u_task.cancel()
                await asyncio.gather(u_task, return_exceptions=True)
                return

            await upstream.send(handshake_json)

            b_task = asyncio.create_task(browser_to_upstream())
            done, pending = await asyncio.wait(
                {b_task, u_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for p in pending:
                p.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    except asyncio.TimeoutError:
        logger.warning('live relay upstream connect timed out after %ss', _UPSTREAM_OPEN_TIMEOUT)
        await _notify_browser_relay_error(
            browser_ws,
            'relay_upstream_timeout',
            'Voice service connection timed out',
        )
        try:
            await browser_ws.close(code=1011, reason='upstream connect timeout')
        except Exception:
            pass
        return
    except Exception as exc:
        logger.warning('live relay upstream failed: %s', exc)
        await _notify_browser_relay_error(
            browser_ws,
            'relay_upstream_failed',
            'Voice relay failed',
        )
        try:
            await browser_ws.close(code=1011, reason='live relay failed')
        except Exception:
            pass
        return

    try:
        await browser_ws.close()
    except Exception:
        pass
