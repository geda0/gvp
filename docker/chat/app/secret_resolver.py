"""Resolve the Gemini API key from Secrets Manager into the process environment.

WHY. `GEMINI_API_KEY` is a NoEcho SAM parameter — protected in CloudFormation, and then
placed in the Lambda's environment in plaintext where `lambda:GetFunctionConfiguration`
returns it. On 2026-10-14 that is precisely how it reached a session transcript: an ordinary
read of the function config printed it.

HOW, and why it is shaped this way. The key is read in SIX places across FOUR modules
(`providers.py`, `gemini_routing.py`, `live_gemini.py`, `main.py`), two of which are on
SECURITY_GLOB. Instead of editing six call sites — two behind a security gate — this resolves
ONCE at bootstrap and writes `os.environ['GEMINI_API_KEY']`, so every existing read site works
unchanged. `main.py` imports `app.providers` at module scope and reads the key only inside
functions, so by the time anything reads it the value is in place.

AVAILABILITY OVER STRICTNESS. This must never take chat down. A plaintext env var is a
disclosure risk; an unreachable chat is a visible outage. Every failure path — boto3 missing,
access denied, secret absent, malformed payload, throttling — leaves whatever `GEMINI_API_KEY`
already holds and logs the reason. Making this strict would turn a key-management improvement
into a single point of failure in front of the entire feature.

NOT A SUBSTITUTE FOR ROTATION. Relocating a key that has already been disclosed does not
un-disclose it. This governs where the key lives from now on; an exposed value still has to be
replaced at the provider.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from typing import Any

logger = logging.getLogger(__name__)

#: Env var naming the secret. Unset -> this module does nothing at all.
ARN_ENV = 'GEMINI_API_KEY_SECRET_ARN'
#: Env var the rest of the app already reads.
KEY_ENV = 'GEMINI_API_KEY'
#: Field to look for when the secret payload is JSON (the console's default shape).
JSON_FIELD = 'GEMINI_API_KEY'

_lock = threading.Lock()
_resolved: bool | None = None


def _announce(message: str) -> None:
    """Report the one-time bootstrap outcome on stderr as well as via the logger.

    MEASURED on the deployed stage host 2026-10-14: a cold start produced NO output from
    this module at all. It runs at `providers.py` IMPORT time, which is before `main.py`'s
    lifespan raises the root logger to INFO, so the INFO record went to an unconfigured
    root logger and was dropped. That made the migration unverifiable - with GEMINI_API_KEY
    still present in the environment, "read the secret" and "silently fell back to the env
    var" look identical from outside.

    Lambda and the Web Adapter capture stderr into CloudWatch regardless of logging
    configuration, so stderr is the only channel guaranteed to work this early. One line,
    and never the key.
    """
    try:
        print('[secret_resolver] ' + message, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 - observability must never break the bootstrap
        pass


def _build_client() -> Any:
    """Separated so tests can inject a fake without touching boto3 or the network."""
    import boto3  # imported lazily: absence must be survivable, not fatal at import

    return boto3.client('secretsmanager')


def _extract(payload: Any) -> str:
    """Accept either a bare secret string or a JSON object carrying the key."""
    text = (payload or '') if isinstance(payload, str) else ''
    text = text.strip()
    if not text:
        return ''
    if text.startswith('{'):
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return ''
        if not isinstance(data, dict):
            return ''
        value = data.get(JSON_FIELD) or data.get(JSON_FIELD.lower()) or data.get('apiKey')
        return str(value).strip() if value else ''
    return text


def resolve_gemini_key_into_env() -> bool:
    """Populate ``GEMINI_API_KEY`` from Secrets Manager. True only if it actually did.

    Idempotent and cached: one fetch per process, because this runs on a cold start and the
    value cannot change under a running container.
    """
    global _resolved
    with _lock:
        if _resolved is not None:
            return _resolved
        _resolved = _resolve_once()
        return _resolved


def _resolve_once() -> bool:
    arn = (os.environ.get(ARN_ENV) or '').strip()
    if not arn:
        # Nothing configured — hosts still on a plaintext env var keep working untouched.
        return False

    try:
        client = _build_client()
        response = client.get_secret_value(SecretId=arn)
    except Exception as exc:  # noqa: BLE001 - every failure must be survivable
        # Deliberately logs the EXCEPTION TYPE and not the message: a Secrets Manager error
        # can echo the secret id, and some wrappers include response bodies.
        logger.warning(
            'could not read %s from Secrets Manager (%s); keeping the existing %s',
            ARN_ENV, type(exc).__name__, KEY_ENV,
        )
        _announce('could not read ' + ARN_ENV + ' from Secrets Manager ('
                  + type(exc).__name__ + '); keeping the existing ' + KEY_ENV)
        return False

    key = _extract(response.get('SecretString') if isinstance(response, dict) else None)
    if not key:
        logger.warning(
            'the secret named by %s held no usable %s; keeping the existing env value',
            ARN_ENV, KEY_ENV,
        )
        _announce('the secret named by ' + ARN_ENV + ' held no usable '
                  + KEY_ENV + '; keeping the env value')
        return False

    os.environ[KEY_ENV] = key
    # Length only. Never the value, and never a prefix — CloudWatch is readable by anyone
    # with logs:FilterLogEvents, which is the disclosure surface this module exists to shrink.
    logger.info('resolved %s from Secrets Manager (%d chars)', KEY_ENV, len(key))
    _announce('resolved ' + KEY_ENV + ' from Secrets Manager ('
              + str(len(key)) + ' chars)')
    return True


def reset_for_tests() -> None:
    """Clear the cached resolution (pytest isolation)."""
    global _resolved
    with _lock:
        _resolved = None
