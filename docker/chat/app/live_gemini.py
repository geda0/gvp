"""Gemini Live API: ephemeral browser tokens + WebSocket handshake payload."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from google import genai
from google.genai import types

from google.genai import _common, _live_converters
from google.genai import _transformers as genai_transformers

from app.live_env import live_model_id

logger = logging.getLogger(__name__)

_live_http_options = types.HttpOptions(api_version='v1alpha')
_live_client: genai.Client | None = None


def _live_client_singleton() -> genai.Client:
    global _live_client
    api_key = (os.environ.get('GEMINI_API_KEY') or '').strip()
    if not api_key:
        raise RuntimeError('GEMINI_API_KEY is not set')
    if _live_client is None:
        _live_client = genai.Client(api_key=api_key, http_options=_live_http_options)
    return _live_client


_LIVE_TOOLS = types.Tool(
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
        types.FunctionDeclaration(
            name='navigate_to_section',
            description=(
                "Navigate to a top-level section of the site. Call this for hands-free movement "
                "when the user asks to go to Home, Portfolio, or Playground/Experiments."
            ),
            parameters=types.Schema(
                type=types.Type.OBJECT,
                properties={
                    'section': types.Schema(
                        type=types.Type.STRING,
                        enum=['home', 'portfolio', 'playground'],
                        description='Section id to navigate to.',
                    ),
                },
                required=['section'],
            ),
        ),
    ],
)


def _live_connect_config(system_instruction: str) -> types.LiveConnectConfig:
    # Gemini Live accepts exactly one modality per session (an AUDIO+TEXT
    # combination is invalid and the upstream silently rejects the setup,
    # surfacing on the client as a 45-60s wait for setupComplete that never
    # arrives). We pick AUDIO and rely on input/output_audio_transcription for
    # the running transcript bubbles.
    return types.LiveConnectConfig(
        system_instruction=system_instruction,
        response_modalities=[types.Modality.AUDIO],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        tools=[_LIVE_TOOLS],
    )


def _build_setup_handshake(
    client: genai.Client, model: str, cfg: types.LiveConnectConfig
) -> dict[str, Any]:
    """Wire-format setup frame for v1alpha BidiGenerateContent[Constrained].

    Mirrors the path google-genai uses for direct-API-key Live sessions
    (live.py: ``_LiveConnectParameters_to_mldev`` → drop ``config`` → re-set
    ``setup.model``). The constrained endpoint validates the setup against the
    locked LiveConnectConstraints baked into the token, so the wire shape must
    match what the SDK would have sent. A minimal ``{setup: {model}}`` causes
    the upstream to close mid-handshake with no useful reason.
    """
    api_client = client._api_client
    transformed_model = genai_transformers.t_model(api_client, model)
    from_object = types.LiveConnectParameters(
        model=transformed_model, config=cfg
    ).model_dump(exclude_none=True)
    request_dict = _common.convert_to_dict(
        _live_converters._LiveConnectParameters_to_mldev(
            api_client=api_client, from_object=from_object
        )
    )
    request_dict.pop('config', None)
    request_dict = _common.encode_unserializable_types(request_dict)
    setup = request_dict.setdefault('setup', {})
    setup['model'] = transformed_model
    return request_dict


GOOGLE_LIVE_HOST = 'generativelanguage.googleapis.com'
GOOGLE_LIVE_PATH = (
    '/ws/google.ai.generativelanguage.v1alpha'
    '.GenerativeService.BidiGenerateContentConstrained'
)
GOOGLE_LIVE_WSS_URI = f'wss://{GOOGLE_LIVE_HOST}{GOOGLE_LIVE_PATH}'


def google_constrained_browser_ws_url(token_name: str) -> str:
    """Direct Google wss URL (access_token query). Use when the chat origin cannot host WebSocket relay."""
    return f'{GOOGLE_LIVE_WSS_URI}?access_token={quote(token_name, safe="/")}'


async def mint_live_session_async(system_instruction: str) -> dict[str, Any]:
    """Mint an unconstrained ephemeral token + full setup handshake.

    The reference google-gemini/gemini-live-api-examples server creates a bare
    token (no ``live_connect_constraints``) and lets the client own the setup
    frame on the WS. We do the same: ``auth_tokens.create()`` ships only the
    knob fields (uses, expire times) so the POST body is tiny and the mint is
    fast. The handshake we hand back to the relay / browser carries the model,
    system_instruction, tools, and transcription config — what actually drives
    the session.

    Why not constraints? Packing a 14 KB system prompt + knowledge XML into
    ``LiveConnectConstraints`` makes the mint POST large and slow; if there's
    *any* mismatch between the constraints and the setup frame, the upstream
    silently rejects the setup and the FE waits 45-60 s for nothing. The token
    is already one-use + 3-minute-window, so the extra hardening from
    constraints wasn't worth the failure mode.
    """
    client = _live_client_singleton()
    mid = live_model_id()
    cfg = _live_connect_config(system_instruction)

    now = datetime.now(timezone.utc)
    # Leave time to open the Live session after mint (mic permission, WS handshake).
    # See https://ai.google.dev/api/live (AuthToken.new_session_expire_time).
    new_session_expire_time = now + timedelta(seconds=180)
    expire_time = now + timedelta(seconds=600)

    auth = await client.aio.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            expire_time=expire_time,
            new_session_expire_time=new_session_expire_time,
        )
    )
    token_name = (auth.name or '').strip()
    if not token_name:
        raise RuntimeError('Auth token response missing name')

    handshake = _build_setup_handshake(client, mid, cfg)
    transformed_model = handshake.get('setup', {}).get('model') or mid

    setup = handshake.get('setup', {})
    si_chars = len((setup.get('systemInstruction') or {}).get('parts', [{}])[0].get('text', '') or '')
    n_tools = sum(len((t or {}).get('functionDeclarations') or []) for t in setup.get('tools') or [])
    logger.info(
        'live mint ok model=%s system_instruction_chars=%s tools=%s modalities=%s',
        transformed_model,
        si_chars,
        n_tools,
        (setup.get('generationConfig') or {}).get('responseModalities'),
    )

    return {
        'handshake': handshake,
        'model': transformed_model,
        'apiVersion': 'v1alpha',
        '_authTokenName': token_name,
    }


async def probe_live_session(system_instruction: str) -> dict[str, Any]:
    """Mint a token, open the upstream WS, send the setup, wait for setupComplete.

    Returns timing per step + the first inbound frame's keys (so we can tell
    setupComplete vs error). Mints a fresh single-use token each call — safe to
    expose as an admin diagnostic. Does *not* go through the browser or relay;
    the only moving parts are the FastAPI app and Google's Live endpoint, so a
    pass here narrows the bug to the relay or the browser.
    """
    import asyncio
    import json
    import time
    import websockets

    result: dict[str, Any] = {'ok': False, 'steps': {}}
    t_total = time.perf_counter()
    try:
        t0 = time.perf_counter()
        minted = await mint_live_session_async(system_instruction)
        result['steps']['mint_ms'] = int((time.perf_counter() - t0) * 1000)
    except Exception as exc:
        result['error'] = f'mint_failed: {exc}'
        return result

    token_name = minted.pop('_authTokenName', '')
    handshake = minted.get('handshake') or {}
    result['model'] = minted.get('model')
    result['handshake_chars'] = len(json.dumps(handshake))

    headers = [('Authorization', f'Token {token_name}')]
    try:
        t0 = time.perf_counter()
        async with websockets.connect(
            GOOGLE_LIVE_WSS_URI,
            additional_headers=headers,
            max_size=None,
            open_timeout=15,
            close_timeout=5,
        ) as upstream:
            result['steps']['ws_open_ms'] = int((time.perf_counter() - t0) * 1000)
            t0 = time.perf_counter()
            await upstream.send(json.dumps(handshake))
            result['steps']['setup_send_ms'] = int((time.perf_counter() - t0) * 1000)

            t0 = time.perf_counter()
            try:
                raw = await asyncio.wait_for(upstream.recv(), timeout=30)
            except asyncio.TimeoutError:
                result['error'] = 'no_first_frame_in_30s'
                return result
            result['steps']['first_frame_ms'] = int((time.perf_counter() - t0) * 1000)
            try:
                first = json.loads(raw if isinstance(raw, str) else raw.decode('utf-8'))
            except Exception:
                first = {'__non_json__': True, 'preview': str(raw)[:200]}
            result['first_frame_keys'] = sorted(first.keys()) if isinstance(first, dict) else []
            result['setup_complete'] = bool(isinstance(first, dict) and (first.get('setupComplete') or first.get('setup_complete')))
            if not result['setup_complete']:
                result['first_frame'] = first
    except Exception as exc:
        result['error'] = f'upstream_failed: {type(exc).__name__}: {exc}'
        return result

    result['ok'] = bool(result.get('setup_complete'))
    result['total_ms'] = int((time.perf_counter() - t_total) * 1000)
    return result
