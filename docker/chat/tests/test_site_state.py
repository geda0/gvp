"""The `siteState` wire contract: one model, one formatter, one line (ADR-0015 §6).

WHY A LEAF MODULE. `format_site_state_line` is called from BOTH `/api/chat` and
`/api/live/session`, and `SiteStateIn` is shared by `ChatRequest` and `LiveSessionRequest`.
Not two classes and not two formatters: `providers.py` and `live_gemini.py` have already
drifted once on exactly this kind of duplication (§9.3), and the cost of that drift was a
voice model that could not emit `labs` at all for four months.

Pure leaf — no FastAPI, no boto3, no I/O — mirroring `turn_input.py`'s shape under invariant
#17, and its discipline too: the bounds are module-private constants asserted FROM THE
OUTSIDE as behaviour, so a bound and the test that pins it cannot be changed in one edit.

THE VALIDATION POSTURE IS NOT UNIFORM, AND THAT IS THE POINT. #17's rule is CLAMP VALUES,
REJECT IDENTITIES:

  - `section` is an enum key and `projectId` is a record key (M4 wants it as an admin facet).
    Silently rewriting an identity makes distinct callers collide into one bucket, which is
    the failure #17 names. So: REJECT, and let the app's existing RequestValidationError
    handler turn it into a 400.
  - `projectTitle` is the only free text, so it CLAMPS.

This departs from `/api/live/transcript`'s clamp-everything posture, and #17 is the reason
rather than an exception to it: that endpoint is a fire-and-forget beacon whose caller never
reads the response, while `/api/chat` IS read by its caller, so a 400 is actionable instead
of lost.

AND ONE RULE THAT IS ABOUT AVAILABILITY, NOT CORRECTNESS (§6.2): an unknown but
pattern-valid `section` is ACCEPTED and passed through verbatim. The frontend and the chat
host deploy independently — Amplify serves `main`'s HTML as-is (invariant #11), so skew is
real and has caused an incident — and ADR-0011's rename will reach one side before the
other. A server that 400s an unrecognised section turns an IA rename into a site-wide chat
outage. The value is already bounded in length and charset; checking it against a
server-side enum buys nothing and costs availability.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.site_state import SiteStateIn, format_site_state_line


def _state(**over):
    base = {
        'section': 'portfolio',
        'projectId': 'team-tactics',
        'projectTitle': 'Team Tactics',
        'contactOpen': False,
        'voiceActive': True,
    }
    base.update(over)
    return base


def test_absent_state_produces_no_line_at_all():
    """§6.2: the model must not be told a fact nobody asserted."""
    assert format_site_state_line(None) == '', (
        'None must render as the empty string, so the caller appends nothing. Not "unknown", '
        'not defaulted to home — an older frontend against a newer server simply says less, '
        'and the prompt stays honest'
    )


def test_the_line_states_what_the_visitor_is_looking_at():
    line = format_site_state_line(SiteStateIn(**_state()))
    assert 'portfolio' in line
    assert 'Team Tactics' in line, (
        'the TITLE is what makes the line sayable out loud — an assistant that has to look '
        'up an id mid-sentence is an assistant that pauses'
    )
    assert line.count('\n') == 0, (
        'one line, so the caller can fold it into a system instruction without reasoning '
        'about where it ends (§6.5)'
    )


def test_the_line_reports_the_contact_form_and_the_voice_session():
    opened = format_site_state_line(SiteStateIn(**_state(contactOpen=True)))
    closed = format_site_state_line(SiteStateIn(**_state(contactOpen=False)))
    assert opened != closed, 'contactOpen must be visible in the line, or it is dead weight'
    assert 'contact' in opened.lower()


def test_a_section_the_server_has_never_heard_of_is_passed_through():
    """THE MIGRATION RULE. Refusing it would turn an IA rename into a chat outage."""
    line = format_site_state_line(SiteStateIn(**_state(section='experience')))
    assert 'experience' in line


@pytest.mark.parametrize('bad', ['Portfolio', 'port folio', 'x' * 33, '', '../etc', '1home'])
def test_a_malformed_section_is_REJECTED_not_clamped(bad):
    with pytest.raises(ValidationError):
        SiteStateIn(**_state(section=bad))


@pytest.mark.parametrize('bad', ['team tactics', 'a' * 65, 'id/with/slash'])
def test_a_malformed_project_id_is_REJECTED_not_clamped(bad):
    """A truncated id is a plausible id for a DIFFERENT record, which the server would then
    accept as real. Dropping loses a fact; truncating invents one."""
    with pytest.raises(ValidationError):
        SiteStateIn(**_state(projectId=bad))


def test_project_title_CLAMPS_because_it_is_the_only_free_text():
    model = SiteStateIn(**_state(projectTitle='T' * 500))
    assert len(model.projectTitle) == 120


def test_a_sixth_key_is_refused():
    """`extra='forbid'`: the shape is bounded in KEY SPACE as well as size (§6.3)."""
    with pytest.raises(ValidationError):
        SiteStateIn(**_state(chatStage='docked'))


def test_every_field_is_optional_so_a_partial_state_still_parses():
    """The frontend sends null for an absent project. A server that required it would 400
    every turn on which no project dialog happened to be open."""
    model = SiteStateIn(section='home', projectId=None, projectTitle=None,
                        contactOpen=False, voiceActive=False)
    assert model.projectId is None
    assert isinstance(format_site_state_line(model), str)


def test_the_serialized_bound_holds_at_every_cap_simultaneously():
    """§6.3: ≤512 bytes, DERIVED by adding the field caps (32 + 64 + 120 + fixed keys and
    punctuation), not measured. If the caps change, redo the addition — do not re-measure."""
    model = SiteStateIn(
        section='s' * 32,
        projectId='p' * 64,
        projectTitle='t' * 120,
        contactOpen=True,
        voiceActive=True,
    )
    assert len(model.model_dump_json().encode('utf-8')) <= 512


def test_the_line_itself_is_bounded_so_a_caller_can_reserve_for_it():
    """§6.6's reserve arithmetic needs a number it can trust BEFORE rendering. A line that
    could outgrow its reserve silently truncates the knowledge pack instead of erroring, and
    the symptom is the voice agent quietly forgetting part of the portfolio."""
    from app.site_state import MAX_SITE_STATE_LINE_CHARS

    worst = SiteStateIn(
        section='s' * 32,
        projectId='p' * 64,
        projectTitle='t' * 120,
        contactOpen=True,
        voiceActive=True,
    )
    assert len(format_site_state_line(worst)) <= MAX_SITE_STATE_LINE_CHARS
    assert MAX_SITE_STATE_LINE_CHARS < 600, (
        'the reserve has to be small enough to be worth reserving — if it approached the '
        'pack budget the trade would be the wrong way round'
    )
