"""Gemini Live API: ephemeral browser tokens + WebSocket handshake payload."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from google import genai
from google.genai import types

from google.genai import _transformers as genai_transformers

from app.live_env import live_model_id

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
    return types.LiveConnectConfig(
        system_instruction=system_instruction,
        response_modalities=[types.Modality.AUDIO, types.Modality.TEXT],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        tools=[_LIVE_TOOLS],
    )


def google_constrained_browser_ws_url(token_name: str) -> str:
    """Direct Google wss URL (access_token query). Use when the chat origin cannot host WebSocket relay."""
    version = 'v1alpha'
    host = 'generativelanguage.googleapis.com'
    path = (
        f'/ws/google.ai.generativelanguage.{version}'
        '.GenerativeService.BidiGenerateContentConstrained'
    )
    return f'wss://{host}{path}?access_token={quote(token_name, safe="/")}'


async def mint_live_session_async(system_instruction: str) -> dict[str, Any]:
    """Mint auth token + minimal setup. Caller chooses relay vs direct Google wss (see CHAT_LIVE_RELAY)."""
    client = _live_client_singleton()
    api_client = client._api_client
    mid = live_model_id()
    cfg = _live_connect_config(system_instruction)

    now = datetime.now(timezone.utc)
    # Ephemeral token: leave time to open a Live session after mint (mic permission, WS handshake).
    # See https://ai.google.dev/api/live (AuthToken.new_session_expire_time).
    new_session_expire_time = now + timedelta(seconds=180)
    expire_time = now + timedelta(seconds=600)

    auth = await client.aio.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            # One token, one session. Default is 1 anyway; previous `uses=8` widened
            # the blast radius if a token ever leaked, with no FE benefit (each
            # /api/live/session call mints a fresh token).
            uses=1,
            expire_time=expire_time,
            new_session_expire_time=new_session_expire_time,
            live_connect_constraints=types.LiveConnectConstraints(
                model=mid,
                config=cfg,
            ),
        )
    )
    token_name = (auth.name or '').strip()
    if not token_name:
        raise RuntimeError('Auth token response missing name')

    transformed_model = genai_transformers.t_model(api_client, mid)

    handshake: dict[str, Any] = {'setup': {'model': transformed_model}}

    version = 'v1alpha'

    return {
        'handshake': handshake,
        'model': transformed_model,
        'apiVersion': version,
        '_authTokenName': token_name,
    }
