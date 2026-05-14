"""Corpus env, lifespan, and httpx AsyncClient for API tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

REPO_ROOT = Path(__file__).resolve().parents[3]

os.environ["CHAT_PROVIDER"] = "mock"
os.environ.setdefault("CHAT_KNOWLEDGE_DIR", str(REPO_ROOT / "data" / "chat-knowledge"))
os.environ.setdefault(
    "CHAT_SYSTEM_PROMPT_PATH",
    str(REPO_ROOT / "docker" / "chat" / "prompts" / "system-prompt.md"),
)
os.environ.setdefault("CHAT_READY_VERBOSE", "1")


@pytest.fixture(autouse=True)
def _reset_gemini_limit_state() -> None:
    from app import gemini_limit_state as gls

    gls.reset_for_tests()
    yield
    gls.reset_for_tests()


@pytest.fixture
async def client() -> AsyncClient:
    from app.main import app

    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
