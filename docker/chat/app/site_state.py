"""The `siteState` wire contract — one model, one formatter (ADR-0015 §6).

Pure leaf: no FastAPI, no boto3, no I/O. Mirrors `turn_input.py`'s shape under invariant
#17, including its discipline — the bounds are module-private constants asserted from the
OUTSIDE as behaviour (`tests/test_site_state.py`), so a bound and the test that pins it
cannot be changed in one edit.

ONE class and ONE formatter, shared by `/api/chat` and `/api/live/session`. `providers.py`
and `live_gemini.py` drifted once on exactly this kind of duplication, and the cost was a
voice model that could not emit `labs` at all for four months.

THE VALIDATION POSTURE IS DELIBERATELY NOT UNIFORM. #17's rule is **clamp values, reject
identities**:

  - `section` is an enum key and `projectId` is a record key (M4 wants it as an admin
    facet). Silently rewriting an identity makes distinct callers collide into one bucket,
    which is the failure #17 names — so both REJECT, and the app's existing
    `RequestValidationError` handler turns that into a 400.
  - `projectTitle` is the only free-text value, so it CLAMPS.

This departs from `/api/live/transcript`'s clamp-everything posture, and #17 is the reason
rather than an exception to it: that endpoint is a fire-and-forget beacon whose caller never
reads the response, while `/api/chat` IS read by its caller, so a 400 is actionable instead
of lost.

AND ONE RULE THAT IS ABOUT AVAILABILITY (§6.2): an unknown but pattern-valid `section` is
ACCEPTED and passed through verbatim. The frontend and the chat host deploy independently —
Amplify serves `main`'s HTML as-is (invariant #11), so skew is real and has caused an
incident — and an IA rename reaches one side before the other. A server that 400s an
unrecognised section turns that rename into a site-wide chat outage. The value is already
bounded in length and charset; checking it against a server-side enum buys nothing.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

_MAX_SECTION = 32
_MAX_PROJECT_ID = 64
_MAX_PROJECT_TITLE = 120

# Lowercase, hyphenated, starts with a letter: the shape every section id in this site has
# ever had. Deliberately a SHAPE and not an enum — see the availability note above.
_SECTION_PATTERN = r'^[a-z][a-z0-9-]{0,31}$'
# A record key, so the charset is wider but still has no path or whitespace characters.
_PROJECT_ID_PATTERN = r'^[A-Za-z0-9._-]{1,64}$'

# The worst-case rendered length, for §6.6's reserve arithmetic. A caller that folds this
# line into a budgeted system instruction needs a number it can trust BEFORE rendering:
# without the reserve the line silently overruns CHAT_LIVE_SYSTEM_MAX_CHARS, and the symptom
# is not an error but a truncated knowledge pack — the voice agent quietly forgetting part of
# the portfolio. DERIVED by addition from the caps plus the fixed prose, not measured.
MAX_SITE_STATE_LINE_CHARS = 420


class SiteStateIn(BaseModel):
    """Five flat keys, depth 1 by construction, no sixth key."""

    model_config = ConfigDict(extra='forbid')

    section: str | None = Field(default=None, max_length=_MAX_SECTION, pattern=_SECTION_PATTERN)
    projectId: str | None = Field(
        default=None, max_length=_MAX_PROJECT_ID, pattern=_PROJECT_ID_PATTERN
    )
    # The one clamp. `str_max_length` would reject rather than truncate, so it is done in a
    # validator instead — see `_clamp_title`.
    projectTitle: str | None = Field(default=None)
    contactOpen: bool = False
    voiceActive: bool = False

    def model_post_init(self, _context: object) -> None:
        if isinstance(self.projectTitle, str) and len(self.projectTitle) > _MAX_PROJECT_TITLE:
            object.__setattr__(self, 'projectTitle', self.projectTitle[:_MAX_PROJECT_TITLE])


def format_site_state_line(site_state: SiteStateIn | None) -> str:
    """Render one line of prose, or '' when there is nothing to assert.

    '' rather than "unknown" or a default, because §6.2 makes ABSENT meaningful: an older
    frontend against a newer server simply says less, and the model is never told a fact
    nobody asserted.
    """
    if site_state is None:
        return ''

    parts: list[str] = []
    if site_state.section:
        parts.append(f'on the {site_state.section} page')
    if site_state.projectId:
        title = (site_state.projectTitle or '').strip() or site_state.projectId
        parts.append(f'with the "{title}" project open')
    if site_state.contactOpen:
        parts.append('with the contact form open')
    # `voiceActive` is on the wire but NOT in the prose: on the live path the model IS the
    # voice session, so saying it is a tautology that costs a clause in every rendering, and
    # on the text path the composer's two modes are mutually exclusive so it is never true
    # there. It stays on the wire because it is worth persisting on the turn (§6.4) — the
    # admin panel wants to know a failed turn happened during a call.

    if not parts:
        return ''
    return 'Current site state: the visitor is ' + ', '.join(parts) + '.'
