"""Corpus env, lifespan, and httpx AsyncClient for API tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

REPO_ROOT = Path(__file__).resolve().parents[3]

os.environ["CHAT_PROVIDER"] = "mock"
os.environ.setdefault(
    "CORPUS_RESUME_PATH",
    str(REPO_ROOT / "resume" / "resume.json"),
)
os.environ.setdefault(
    "CORPUS_PROJECTS_PATH",
    str(REPO_ROOT / "data" / "projects.json"),
)


@pytest.fixture
async def client() -> AsyncClient:
    from app.main import app

    async with LifespanManager(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac
