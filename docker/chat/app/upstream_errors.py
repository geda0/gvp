"""Map provider/SDK exceptions to HTTP status + JSON body (redacted detail)."""

from __future__ import annotations

import re
from typing import Any


def _redacted_error_summary(exc: BaseException, max_len: int = 400) -> str:
    raw = f"{type(exc).__name__}: {exc}"
    raw = re.sub(r"AIza[0-9A-Za-z_-]{10,}", "[REDACTED_API_KEY]", raw, flags=re.I)
    raw = re.sub(r"sk-[A-Za-z0-9]{15,}", "[REDACTED]", raw)
    raw = re.sub(r"Bearer\s+[A-Za-z0-9._-]{8,}", "Bearer [REDACTED]", raw)
    return raw[:max_len].strip()


def upstream_error_body(exc: BaseException) -> tuple[int, dict[str, Any]]:
    """Return (http_status, body_dict) for JSONResponse; body includes redacted detail when useful."""
    detail = _redacted_error_summary(exc)

    try:
        import httpx

        if isinstance(exc, httpx.HTTPStatusError):
            sc = exc.response.status_code
            if sc == 429:
                return 429, {
                    "error": "Model provider rate limited the request",
                    "code": "upstream_rate_limited",
                    "detail": detail,
                }
            if sc in (401, 403):
                return 502, {
                    "error": "Model provider authentication failed",
                    "code": "upstream_auth_error",
                    "detail": detail,
                }
            return 502, {
                "error": "Upstream HTTP error from model provider",
                "code": "model_error",
                "detail": detail,
            }
    except ImportError:
        pass

    try:
        from google.api_core import exceptions as ge

        if isinstance(exc, ge.PermissionDenied):
            return 502, {
                "error": "Model provider denied access (check API key and Generative Language API)",
                "code": "upstream_auth_error",
                "detail": detail,
            }
        if isinstance(exc, ge.Unauthenticated):
            return 502, {
                "error": "Model provider authentication failed",
                "code": "upstream_auth_error",
                "detail": detail,
            }
        if isinstance(exc, ge.ResourceExhausted):
            return 429, {
                "error": "Model provider quota exceeded",
                "code": "upstream_rate_limited",
                "detail": detail,
            }
        if isinstance(exc, ge.NotFound):
            return 502, {
                "error": "Model or API resource not found",
                "code": "model_error",
                "detail": detail,
            }
        if isinstance(exc, (ge.InvalidArgument, ge.FailedPrecondition, ge.BadRequest)):
            return 502, {
                "error": "Model provider rejected the request",
                "code": "model_error",
                "detail": detail,
            }
        if isinstance(exc, ge.GoogleAPICallError):
            return 502, {
                "error": "Upstream model error",
                "code": "model_error",
                "detail": detail,
            }
    except ImportError:
        pass

    status = _extract_status_code_from_chain(exc)
    if status == 429:
        return 429, {
            "error": "Model provider rate limited the request",
            "code": "upstream_rate_limited",
            "detail": detail,
        }
    if status in (401, 403):
        return 502, {
            "error": "Model provider authentication failed",
            "code": "upstream_auth_error",
            "detail": detail,
        }

    return 502, {
        "error": "Upstream model error",
        "code": "model_error",
        "detail": detail,
    }


def _extract_status_code_from_chain(exc: BaseException) -> int | None:
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        status = getattr(cur, "status_code", None)
        if isinstance(status, int):
            return status
        response = getattr(cur, "response", None)
        if response is not None:
            status = getattr(response, "status_code", None)
            if isinstance(status, int):
                return status
        cur = cur.__cause__ or cur.__context__
    return None
