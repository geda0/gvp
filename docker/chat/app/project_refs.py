"""The shared project-id tuple for the open_project / close_project tool declarations.

M4 slice 1 (ADR-0017 §3.1). Both `providers.chat_tools()` and `live_gemini`'s Live tools import
PROJECT_IDS, so the text and voice enums are equal BY CONSTRUCTION - the cheap fix for the drift
that cost `navigate_to_section` four months of a missing `labs`.

A LEAF (ADR-0018): voice imports it, and voice may not import the assistant layer, so this finds
the knowledge pack itself instead of importing knowledge_context. Same resolution order:
CHAT_KNOWLEDGE_DIR, else the nearest ancestor holding data/chat-knowledge.

Never raises. A missing or malformed pack yields an empty tuple, and the declarations then omit
the project tools rather than declaring an empty enum (which Gemini rejects).
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def _pack_dir() -> Path | None:
    env_path = (os.environ.get('CHAT_KNOWLEDGE_DIR') or '').strip()
    if env_path:
        return Path(env_path)
    cur = Path(__file__).resolve().parent
    for _ in range(32):
        candidate = cur / 'data' / 'chat-knowledge'
        if candidate.is_dir():
            return candidate
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def load_project_ids() -> tuple[str, ...]:
    pack = _pack_dir()
    if pack is None:
        return ()
    try:
        rows = json.loads((pack / 'projects.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return ()
    if not isinstance(rows, list):
        return ()
    ids: list[str] = []
    for row in rows:
        pid = row.get('id') if isinstance(row, dict) else None
        if isinstance(pid, str) and pid.strip() and pid not in ids:
            ids.append(pid.strip())
    return tuple(ids)


#: Computed once at import, from the pack the process ships with.
PROJECT_IDS: tuple[str, ...] = load_project_ids()
