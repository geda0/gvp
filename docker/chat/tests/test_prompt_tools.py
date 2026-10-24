"""M4 chat slice 5 (ADR-0017 §3.6): the system prompt's tool guidance matches what is declared.

The prompt said "You have two tools" while three were declared (navigate_to_section was never
listed) - and M4 adds two more. The tool list is DERIVED from the text-path declarations, so the
prompt cannot fall behind again. Static guidance lives in the prompt because it sits inside the
cacheable prefix: paid once, served from cache.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.knowledge_context import parse_prompt_version
from app.providers import chat_tools

PROMPT = (Path(__file__).resolve().parents[1] / 'prompts' / 'system-prompt.md').read_text()
DECLARED = [d.name for d in chat_tools()[0].function_declarations]


def test_prompt_version_is_1_7_0():
    assert parse_prompt_version(PROMPT) == '1.7.0'


def test_the_prompt_guides_every_declared_tool():
    missing = [name for name in DECLARED if f'`{name}(' not in PROMPT]
    assert missing == [], f'declared but never explained in the prompt: {missing}'


def test_the_prompt_does_not_state_a_stale_tool_count():
    words = {2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six'}
    m = re.search(r'You have (\w+) tools', PROMPT)
    if m:
        assert m.group(1) == words.get(len(DECLARED), str(len(DECLARED))), m.group(0)


def test_the_prompt_pairs_open_project_with_close_project():
    """ADR-0017 §3.6: a model that opens cards and never closes them narrates a stack that
    does not exist (there is one dialog; a second open replaces the first)."""
    section = PROMPT[PROMPT.index('`open_project('):]
    assert 'close_project' in section[:600]
    assert re.search(r'one (project )?card', section[:600], re.I)
