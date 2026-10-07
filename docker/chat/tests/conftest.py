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


@pytest.fixture(autouse=True)
def _reset_smoke_cooldown_state() -> None:
    from app import main

    main.reset_smoke_cooldown_for_tests()
    yield
    main.reset_smoke_cooldown_for_tests()


@pytest.fixture
async def client() -> AsyncClient:
    from app.main import app

    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


class StubStore:
    """Transcript store stand-in that records every write it is asked to make,
    so a test can assert on the row persistence actually received (ADR-0002) —
    or that a rejected request wrote nothing at all."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def persist_turn(self, **kwargs) -> None:
        self.calls.append(kwargs)


@pytest.fixture
def stub_store(client) -> StubStore:
    """Swap `app.state.transcript_store` for a recording stub, and restore the
    real one in teardown. Depends on `client` so the swap happens AFTER the
    lifespan startup that assigns the real store (`main.py:370`) — installing it
    earlier would be silently overwritten. Replaces the hand-rolled
    save/swap/try-finally dance one of these tests eventually forgets, leaking a
    stub into the next test."""
    from app.main import app

    store_before = app.state.transcript_store
    stub = StubStore()
    app.state.transcript_store = stub
    try:
        yield stub
    finally:
        app.state.transcript_store = store_before
