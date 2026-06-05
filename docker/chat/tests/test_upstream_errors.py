"""upstream_error_body maps SDK errors to stable codes + redacted detail."""

from __future__ import annotations

import httpx

from app.upstream_errors import is_upstream_rate_limit, upstream_error_body


def test_upstream_generic_exception_has_detail() -> None:
    status, body = upstream_error_body(RuntimeError("something broke"))
    assert status == 502
    assert body["code"] == "model_error"
    assert "RuntimeError" in body["detail"]


def test_upstream_redacts_gemini_key_shape() -> None:
    status, body = upstream_error_body(ValueError("bad AIzaSyDUMMYKEY123456789012345678901234567"))
    assert status == 502
    assert body["code"] == "model_error"
    assert "[REDACTED_API_KEY]" in body["detail"]


def test_upstream_httpx_403() -> None:
    req = httpx.Request("POST", "https://example.com")
    resp = httpx.Response(403, request=req)
    exc = httpx.HTTPStatusError("denied", request=req, response=resp)
    status, body = upstream_error_body(exc)
    assert status == 502
    assert body["code"] == "upstream_auth_error"


def test_upstream_google_permission_denied() -> None:
    from google.api_core import exceptions as ge

    exc = ge.PermissionDenied("API key not valid")
    status, body = upstream_error_body(exc)
    assert status == 502
    assert body["code"] == "upstream_auth_error"
    assert "PermissionDenied" in body["detail"]


def test_is_upstream_rate_limit_httpx_429() -> None:
    req = httpx.Request("POST", "https://example.com")
    resp = httpx.Response(429, request=req)
    exc = httpx.HTTPStatusError("rl", request=req, response=resp)
    assert is_upstream_rate_limit(exc) is True


def test_is_upstream_rate_limit_google_resource_exhausted() -> None:
    from google.api_core import exceptions as ge

    assert is_upstream_rate_limit(ge.ResourceExhausted("quota")) is True


def test_is_upstream_rate_limit_generic_false() -> None:
    assert is_upstream_rate_limit(RuntimeError("nope")) is False


def test_genai_client_error_429_is_classified_as_rate_limited() -> None:
    # The real google-genai SDK raises google.genai.errors.ClientError for 4xx
    # (see APIError.raise_error: 400<=code<500 -> ClientError). It exposes
    # .code / .status, NOT .status_code, built from the response error json.
    from google.genai.errors import ClientError

    exc = ClientError(
        429,
        {
            "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "message": "Quota exceeded for quota metric 'Generate requests'.",
            }
        },
    )

    assert is_upstream_rate_limit(exc) is True

    status, body = upstream_error_body(exc)
    assert status == 429
    assert body["code"] == "upstream_rate_limited"
