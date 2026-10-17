"""Do the TEXT and VOICE paths agree on what sections exist?

WHY THIS EXISTS — measured 2026-10-15/16.

`navigate_to_section` is declared TWICE, once per path, and the two declarations have
drifted:

    docker/chat/app/providers.py:154    enum=['home', 'portfolio', 'labs']
    docker/chat/app/live_gemini.py:80   enum=['home', 'portfolio', 'playground']

So the VOICE model is told the site has a "Playground" that no longer exists, and **cannot
emit `labs` at all**. It appears to work only because `js/section-names.js:6` maps the legacy
`playground` onto the Labs bucket. Remove that alias — which a future IA tidy-up easily
would — and voice navigation breaks silently while text navigation keeps working.

This is a PRECONDITION for the rest of M2, not a cosmetic tidy. ADR-0015 §11.2 puts it first
in the chat half for that reason: every voice navigation assertion in the milestone is
meaningless while the voice model is working from a different vocabulary than the thing it
is driving.

A second, smaller drift: `chat_tools()`'s own docstring claims the text declarations are the
Live ones "minus navigate_to_section", and the function contradicts that fifty lines below by
declaring it. ADR-0010 §2 (navigation parity on the text path) shipped; the docstring was
never updated.

WHAT THIS PINS, and why equality rather than presence: an earlier backlog item asked only
that the text path "declares the navigation tool". That was already true and still left the
two enums disagreeing — presence is satisfiable while the contract is broken. So the
assertion is that the two declarations are the SAME SET, and that the set is the one the
frontend actually resolves.

The shipped vocabulary is `home | portfolio | labs` (`js/section-names.js`), with
`playground` accepted as a LEGACY INPUT alias and never advertised. ADR-0010 §1's
`{home, work, experience, contact}` is void — it was explicitly conditional on the
Portfolio+Labs merge, which ADR-0011 proposed and `f454481` reverted.
"""

from __future__ import annotations

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / 'app'

# The vocabulary the FRONTEND resolves (js/section-names.js). The declarations must match
# this, not each other only — two paths can agree and both still be wrong.
SHIPPED_SECTIONS = {'home', 'portfolio', 'labs'}

# Advertised NOWHERE: accepted as legacy input by the FE resolver, but a declaration that
# offers it teaches the model a section that does not exist.
LEGACY_ONLY = 'playground'


def _nav_enum(source: str) -> set[str]:
    """Pull the navigate_to_section enum out of its tool declaration.

    Anchored on `name='navigate_to_section'`, NOT on the bare identifier: both modules also
    mention the tool inside prose descriptions ("call navigate_to_section(...)"), and
    anchoring on the first occurrence finds the prose instead of the declaration.
    """
    m = re.search(r"name\s*=\s*['\"]navigate_to_section['\"]", source)
    assert m, 'navigate_to_section is not DECLARED in this module (prose mention is not a declaration)'
    # Window generous enough to survive explanatory comments between the name and the enum —
    # a 1200-char window broke the moment the fix added a comment block above `enum=`, which
    # is a silly way for a contract test to fail.
    window = source[m.end():m.end() + 4000]
    e = re.search(r'enum\s*=\s*\[([^\]]*)\]', window)
    assert e, 'no enum= found inside the navigate_to_section declaration'
    return {v.strip().strip('\'"') for v in e.group(1).split(',') if v.strip()}


def test_text_and_voice_declare_the_same_sections():
    text = _nav_enum((APP / 'providers.py').read_text())
    voice = _nav_enum((APP / 'live_gemini.py').read_text())

    assert text == voice, (
        'the text and voice navigate_to_section enums disagree — text='
        f'{sorted(text)}, voice={sorted(voice)}. The model on one path is being taught a '
        'different site than the model on the other, so every voice navigation assertion in '
        'M2 is meaningless until they match. Pinned as EQUALITY, not presence: an earlier '
        'backlog item asked only that the text path declare the tool, which was already true '
        'while the enums still disagreed.'
    )


def test_both_declare_exactly_the_sections_the_frontend_resolves():
    for module in ('providers.py', 'live_gemini.py'):
        got = _nav_enum((APP / module).read_text())
        assert got == SHIPPED_SECTIONS, (
            f'{module} declares {sorted(got)} but js/section-names.js resolves '
            f'{sorted(SHIPPED_SECTIONS)}. Agreeing with each other is not enough — both can '
            'agree and both be wrong.'
        )


def test_neither_advertises_the_legacy_alias():
    for module in ('providers.py', 'live_gemini.py'):
        got = _nav_enum((APP / module).read_text())
        assert LEGACY_ONLY not in got, (
            f'{module} advertises {LEGACY_ONLY!r}. The frontend accepts it as a legacy INPUT '
            '(js/section-names.js:6) so old bookmarks keep working, but a declaration that '
            'offers it teaches the model a section the site does not have — which is exactly '
            'how voice came to be unable to emit `labs`.'
        )


def test_the_chat_tools_docstring_does_not_contradict_the_function():
    """It claimed the text tools were Live's "minus navigate_to_section" — and declares it."""
    source = (APP / 'providers.py').read_text()
    idx = source.find('def chat_tools(')
    assert idx >= 0, 'chat_tools() not found'
    doc = source[idx:idx + 700]

    declares_nav = 'navigate_to_section' in source[idx:]
    assert declares_nav, 'chat_tools no longer declares navigate_to_section — update this test'

    assert not re.search(r'minus\s+\n?\s*navigate_to_section', doc), (
        "chat_tools()'s docstring still says the text declarations are Live's \"minus "
        'navigate_to_section\", which the function contradicts by declaring it. ADR-0010 §2 '
        '(navigation parity on the text path) shipped; the docstring did not follow.'
    )
