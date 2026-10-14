"""Can the Gemini key come from Secrets Manager instead of a plaintext Lambda env var?

WHY THIS EXISTS.

`GEMINI_API_KEY` is a NoEcho SAM parameter, which protects it in CloudFormation — and then
lands it in the Lambda's environment in plaintext, readable by anyone with
`lambda:GetFunctionConfiguration`. On 2026-10-14 that is exactly how it leaked into a session
transcript: a routine read of the function config printed it.

The key is read in SIX places across FOUR modules (`providers.py`, `gemini_routing.py`,
`live_gemini.py`, `main.py`), and two of those modules are on SECURITY_GLOB. Rather than edit
six call sites — two of them behind a security gate — the resolver runs ONCE at bootstrap and
populates `os.environ['GEMINI_API_KEY']`. Every existing read site then works unchanged.
`main.py` imports `app.providers` at module scope and reads the key only inside functions, so
the ordering holds.

DESIGN RULE, and it is the important one: **this must never take chat down.** A plaintext env
var is a disclosure risk; an unavailable chat is a visible outage. So every failure path —
no boto3, no permission, missing secret, malformed JSON, throttling — falls back to whatever
`GEMINI_API_KEY` already holds and logs the reason. Strictness here would convert a key-
management improvement into a single point of failure in front of the whole feature.

NOT A SUBSTITUTE FOR ROTATION. Moving a key that has already been disclosed does not
un-disclose it. This changes where the key lives from now on; the exposed value still has to
be replaced at the provider.
"""

from __future__ import annotations

import json
import logging

import pytest

from app import secret_resolver


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    """Each test starts with no cached resolution and no inherited key."""
    secret_resolver.reset_for_tests()
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('GEMINI_API_KEY_SECRET_ARN', raising=False)


class _FakeClient:
    """Stands in for boto3's secretsmanager client."""

    def __init__(self, payload=None, error=None):
        self._payload = payload
        self._error = error
        self.calls = 0

    def get_secret_value(self, SecretId):  # noqa: N803 - boto3's own kwarg name
        self.calls += 1
        if self._error:
            raise self._error
        return {'SecretString': self._payload}


def _install(monkeypatch, client):
    monkeypatch.setattr(secret_resolver, '_build_client', lambda: client)
    return client


# ------------------------------------------------------------------ the happy path


def test_a_plain_secret_string_becomes_the_env_key(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    _install(monkeypatch, _FakeClient(payload='key-from-secrets-manager'))

    assert secret_resolver.resolve_gemini_key_into_env() is True
    import os
    assert os.environ['GEMINI_API_KEY'] == 'key-from-secrets-manager', (
        'the resolved secret must land in os.environ so all six existing read sites — two of '
        'them in SECURITY_GLOB files that are deliberately NOT edited — see it unchanged'
    )


def test_a_json_secret_is_read_by_key(monkeypatch):
    """Secrets Manager console-created secrets are usually JSON, not a bare string."""
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    _install(monkeypatch, _FakeClient(payload=json.dumps({'GEMINI_API_KEY': 'json-key'})))

    assert secret_resolver.resolve_gemini_key_into_env() is True
    import os
    assert os.environ['GEMINI_API_KEY'] == 'json-key'


def test_it_fetches_once_per_process(monkeypatch):
    """One SM call per container, not one per turn — this runs on a cold start."""
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    client = _install(monkeypatch, _FakeClient(payload='cached-key'))

    for _ in range(4):
        secret_resolver.resolve_gemini_key_into_env()

    assert client.calls == 1, f'expected one fetch, made {client.calls}'


# ------------------------------------------------------- availability over strictness


def test_without_an_arn_it_leaves_the_existing_env_key_alone(monkeypatch):
    """Backwards compatible: hosts still on a plaintext env var keep working untouched."""
    monkeypatch.setenv('GEMINI_API_KEY', 'env-key')
    client = _install(monkeypatch, _FakeClient(payload='should-not-be-used'))

    assert secret_resolver.resolve_gemini_key_into_env() is False
    import os
    assert os.environ['GEMINI_API_KEY'] == 'env-key'
    assert client.calls == 0, 'no ARN configured means no Secrets Manager call at all'


@pytest.mark.parametrize('boom', [
    RuntimeError('AccessDeniedException'),
    RuntimeError('ResourceNotFoundException'),
    RuntimeError('ThrottlingException'),
])
def test_any_fetch_failure_falls_back_instead_of_crashing(monkeypatch, boom, caplog):
    """A key-management improvement must not become an outage in front of chat."""
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    monkeypatch.setenv('GEMINI_API_KEY', 'fallback-env-key')
    _install(monkeypatch, _FakeClient(error=boom))

    with caplog.at_level(logging.WARNING):
        assert secret_resolver.resolve_gemini_key_into_env() is False

    import os
    assert os.environ['GEMINI_API_KEY'] == 'fallback-env-key', (
        'a Secrets Manager failure must leave the existing key in place — an unavailable '
        'chat is worse than a plaintext env var'
    )
    assert caplog.text.strip(), 'the failure must be logged, not swallowed silently'


def test_a_malformed_secret_does_not_clobber_a_working_key(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    monkeypatch.setenv('GEMINI_API_KEY', 'fallback-env-key')
    # Valid JSON, but no key we recognise — and an empty string must not win either.
    _install(monkeypatch, _FakeClient(payload=json.dumps({'wrong_field': ''})))

    assert secret_resolver.resolve_gemini_key_into_env() is False
    import os
    assert os.environ['GEMINI_API_KEY'] == 'fallback-env-key'


def test_a_missing_boto3_is_not_fatal(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    monkeypatch.setenv('GEMINI_API_KEY', 'fallback-env-key')

    def _no_boto():
        raise ImportError('No module named boto3')

    monkeypatch.setattr(secret_resolver, '_build_client', _no_boto)
    assert secret_resolver.resolve_gemini_key_into_env() is False
    import os
    assert os.environ['GEMINI_API_KEY'] == 'fallback-env-key'


# --------------------------------------------------------------------- disclosure


def test_the_secret_value_is_never_logged(monkeypatch, caplog):
    """The whole point is to stop the key appearing in places people read."""
    monkeypatch.setenv('GEMINI_API_KEY_SECRET_ARN', 'arn:aws:secretsmanager:::secret:gvp/gemini')
    secret = 'AIza-super-secret-value-9876'
    _install(monkeypatch, _FakeClient(payload=secret))

    with caplog.at_level(logging.DEBUG):
        secret_resolver.resolve_gemini_key_into_env()

    assert secret not in caplog.text, (
        'the resolved key appeared in the logs, which re-creates the exact disclosure this '
        'module exists to remove — CloudWatch is readable by anyone with logs:FilterLogEvents'
    )


# ------------------------------------------------------------------------ wiring


def test_providers_resolves_at_import_so_gated_read_sites_need_no_edit():
    """A resolver nothing calls is the starfield depth-fade bug again."""
    from pathlib import Path
    src = Path(__file__).resolve().parents[1] / 'app' / 'providers.py'
    body = src.read_text()
    assert 'secret_resolver' in body, (
        'app/providers.py must invoke the resolver at import time. main.py imports '
        'app.providers at module scope and reads GEMINI_API_KEY only inside functions, so '
        'resolving here populates os.environ before any read — which is what lets main.py '
        'and live_gemini.py (both SECURITY_GLOB) stay untouched.'
    )
    assert 'resolve_gemini_key_into_env' in body
