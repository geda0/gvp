"""Lambda ASGI entry can be imported (Mangum + FastAPI)."""

from __future__ import annotations


def test_lambda_handler_importable() -> None:
    from app import lambda_handler

    assert callable(lambda_handler.handler)
