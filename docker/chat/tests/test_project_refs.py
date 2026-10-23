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


# ---- M4 chat slice 4 (ADR-0017 §4.2): the voice path's project grounding.
# On voice the knowledge blob is truncated to ~31% of the pack and <relevant_projects> never
# arrives, so the open project's detail rides in the SITE-STATE RESERVE as one sentence:
# server-only (the browser has no pack, so format_site_state_line and its shared fixture table
# stay untouched), built from the project's existing one-liner, bounded.
from app.knowledge_context import build_live_system_instruction, load_knowledge_pack  # noqa: E402

PACK = load_knowledge_pack(REPO / 'data' / 'chat-knowledge')


def test_grounding_line_names_the_project_and_its_one_liner():
    line = project_refs.project_grounding_line('team-tactics', PACK)
    project = next(p for p in PACK['projects'] if p['id'] == 'team-tactics')
    assert project['name'] in line
    assert line.endswith('.') and len(line) <= project_refs.GROUNDING_MAX_CHARS


def test_grounding_line_is_empty_for_unknown_or_missing_ids():
    for pid in (None, '', 'not-a-project', 'constructor'):
        assert project_refs.project_grounding_line(pid, PACK) == ''


def test_every_project_line_respects_the_cap():
    for p in PACK['projects']:
        assert len(project_refs.project_grounding_line(p['id'], PACK)) <= project_refs.GROUNDING_MAX_CHARS


def test_the_live_instruction_still_fits_with_a_maximal_site_line_and_grounding_line(monkeypatch):
    monkeypatch.delenv('CHAT_LIVE_SYSTEM_MAX_CHARS', raising=False)
    from app.site_state import SiteStateIn, format_site_state_line

    site = format_site_state_line(SiteStateIn(
        section='portfolio', projectId='a' * 64, projectTitle='T' * 500, contactOpen=True, voiceActive=True,
    ))
    grounding = max((project_refs.project_grounding_line(p['id'], PACK) for p in PACK['projects']), key=len)
    prompt = (REPO / 'docker' / 'chat' / 'prompts' / 'system-prompt.md').read_text()
    text = build_live_system_instruction(prompt, PACK, site_state_line=f'{site} {grounding}'.strip())
    assert len(text) <= 14000
    assert grounding in text, 'the grounding sentence must survive the final truncate'


def test_the_live_session_appends_the_grounding_line_to_the_site_line():
    from app.main import LiveSessionRequest, _live_site_line

    req = LiveSessionRequest.model_validate({'siteState': {'section': 'labs', 'projectId': 'team-tactics', 'projectTitle': 'Team Tactics'}})
    line = _live_site_line(req.siteState, PACK)
    assert line.endswith(project_refs.project_grounding_line('team-tactics', PACK))
    assert _live_site_line(None, PACK) == ''
