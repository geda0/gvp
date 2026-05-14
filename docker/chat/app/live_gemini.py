"""Gemini Live API: ephemeral browser tokens + WebSocket handshake payload."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

from google import genai
from google.genai import types

from google.genai import _common as genai_common
from google.genai import _live_converters as live_converters
from google.genai import _transformers as genai_transformers
from google.genai._common import set_value_by_path as genai_setv

_live_http_options = types.HttpOptions(api_version='v1alpha')
_live_client: genai.Client | None = None


def live_model_id() -> str:
    return (os.environ.get('GEMINI_LIVE_MODEL') or 'gemini-3.1-flash-live-preview').strip()


def _live_client_singleton() -> genai.Client:
    global _live_client
    api_key = (os.environ.get('GEMINI_API_KEY') or '').strip()
    if not api_key:
        raise RuntimeError('GEMINI_API_KEY is not set')
    if _live_client is None:
        _live_client = genai.Client(api_key=api_key, http_options=_live_http_options)
    return _live_client


def _live_connect_config(system_instruction: str) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        system_instruction=system_instruction,
        response_modalities=[types.Modality.AUDIO, types.Modality.TEXT],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )


def build_live_handshake_dict(api_client: Any, model_id: str, cfg: types.LiveConnectConfig) -> dict[str, Any]:
    transformed_model = genai_transformers.t_model(api_client, model_id)
    request_dict = genai_common.convert_to_dict(
        live_converters._LiveConnectParameters_to_mldev(
            api_client=api_client,
            from_object=types.LiveConnectParameters(
                model=transformed_model,
                config=cfg,
            ).model_dump(exclude_none=True),
        )
    )
    del request_dict['config']
    request_dict = genai_common.encode_unserializable_types(request_dict)
    genai_setv(request_dict, ['setup', 'model'], transformed_model)
    return request_dict


async def mint_live_session_async(system_instruction: str) -> dict[str, Any]:
    """Return websocket URL (with access_token), handshake JSON, and model resource."""
    client = _live_client_singleton()
    api_client = client._api_client
    mid = live_model_id()
    cfg = _live_connect_config(system_instruction)

    auth = await client.aio.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=4,
            live_connect_constraints=types.LiveConnectConstraints(
                model=mid,
                config=cfg,
            ),
        )
    )
    token_name = (auth.name or '').strip()
    if not token_name:
        raise RuntimeError('Auth token response missing name')

    handshake = build_live_handshake_dict(api_client, mid, cfg)
    transformed_model = genai_transformers.t_model(api_client, mid)

    version = 'v1alpha'
    host = 'generativelanguage.googleapis.com'
    path = (
        f'/ws/google.ai.generativelanguage.{version}'
        '.GenerativeService.BidiGenerateContentConstrained'
    )

    ws_url = f'wss://{host}{path}?access_token={quote(token_name, safe="")}'

    return {
        'websocketUrl': ws_url,
        'handshake': handshake,
        'model': transformed_model,
        'apiVersion': version,
    }
