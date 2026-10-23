"""M4 chat slice 1 (ADR-0017 §3.1): one shared project-id tuple for both tool declarations.

Derived from the knowledge pack (data/chat-knowledge/projects.json), which is itself generated
from data/projects.json (invariant #15). The cross-file assertion is the one that catches a
content edit that adds a card without rebuilding the pack.
"""

from __future__ import annotations

import json
from pathlib import Path

from app import project_refs

REPO = Path(__file__).resolve().parents[3]


def _site_ids() -> list[str]:
    data = json.loads((REPO / 'data' / 'projects.json').read_text(encoding='utf-8'))
    groups = data.values() if isinstance(data, dict) else [data]
    return [p['id'] for group in groups if isinstance(group, list) for p in group if p.get('id')]


def test_the_shared_tuple_is_exactly_the_sites_project_ids_in_order():
    assert project_refs.PROJECT_IDS == tuple(_site_ids())
    assert len(project_refs.PROJECT_IDS) >= 13


def test_it_is_a_tuple_of_unique_lowercase_ids():
    ids = project_refs.PROJECT_IDS
    assert isinstance(ids, tuple)
    assert len(set(ids)) == len(ids)
    assert all(i == i.strip().lower() and ' ' not in i for i in ids)


def test_a_missing_pack_yields_an_empty_tuple_not_a_crash(tmp_path, monkeypatch):
    monkeypatch.setenv('CHAT_KNOWLEDGE_DIR', str(tmp_path))
    assert project_refs.load_project_ids() == ()


def test_a_malformed_pack_yields_an_empty_tuple(tmp_path, monkeypatch):
    (tmp_path / 'projects.json').write_text('{not json', encoding='utf-8')
    monkeypatch.setenv('CHAT_KNOWLEDGE_DIR', str(tmp_path))
    assert project_refs.load_project_ids() == ()
