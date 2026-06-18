# ADR-0010 — Agent as guide: navigation parity, guided tour, and résumé posture

Status: Accepted
Date: 2026-06-17
Supersedes: none (extends the chat tool surface from ADR-0007; references the IA in ADR-0011)

## Context

The owner is reframing the site to a projects-first "Work" showcase (see ADR-0011) and
turning the chat agent from a Q&A bot into a **site guide**. The agent must be able to move
the visitor through the page and narrate, and it must stop reflexively opening the résumé PDF.

Today the tool surface is split and inconsistent:

- **Text path** (`docker/chat/app/providers.py`, `chat_tools()`): exposes only `open_resume`
  + `open_contact_form`. No navigation.
- **Voice path** (`docker/chat/app/live_gemini.py`, `_LIVE_TOOLS`): exposes those two **plus**
  `navigate_to_section` with `enum=['home','portfolio','playground']`.
- **FE handlers** (`js/chat.js`): the text action handler maps `open-resume` →
  `window.open(RESUME_URL, '_blank')` and `open-contact` → contact dialog. The voice tool
  dispatcher `applyVoiceToolCall` additionally handles `navigate_to_section` (home / labs /
  playground / portfolio → hash routes). So the FE already knows how to navigate; only the
  text path can't ask it to.
- **System prompt** (`docker/chat/prompts/system-prompt.md`, v1.5.0) tells the model
  `open_resume()` is appropriate "when the visitor asks for the resume, asks for a career
  summary, **or appears to be doing initial qualification**" — i.e. it invites the résumé as a
  default opening move, and it opens a new tab (away from the work).

This ADR defines the stable agent-as-guide tool contract so the text path, the voice path,
and the FE can be built independently against it, and clears the gated chat edits required.

## Decision

### 1. Section id contract (shared vocabulary)

The tool's `section` enum is the **IA section vocabulary** owned by ADR-0011. After the
Portfolio+Labs merge it is:

```
section ∈ { 'home', 'work', 'experience', 'contact' }
```

- `home` — the hero / landing.
- `work` — the unified projects-first Work showcase (formerly portfolio + labs).
- `experience` — the new **inline** experience/résumé section on the page (ADR-0011).
- `contact` — the contact surface (opens the contact dialog; see note below).

**Legacy-input tolerance (do not break voice mid-migration):** the FE handler MUST accept the
pre-merge values and resolve them, so a model that still emits the old enum keeps working:

```
'portfolio' → 'work'
'labs'      → 'work'
'playground'→ 'work'
'home'      → 'home'
```

The tool *declarations* (text + voice) ship the **new** enum `['home','work','experience']`
(see §4 on `contact`). The FE *handler* accepts new ∪ legacy. This is the seam: declaration
narrows over time, handler stays tolerant.

### 2. Navigation parity — `navigate_to_section` on the text path

Add `navigate_to_section` to `chat_tools()` in `providers.py` with the **same name, the same
single `section` string param, and `required=['section']`** as the voice declaration in
`live_gemini.py`. Both declarations use the new enum from §1.

The wire contract back to the FE for the text path reuses the existing action envelope. A
`navigate_to_section` tool call from the text model becomes an action object in the `/api/chat`
response (`actions: [...]`), mapped in `main.py`'s `_actions_from_result`:

```json
{ "id": "navigate", "section": "<resolved section id>" }
```

- The FE renders this as a chat action button (consistent with `open-resume`/`open-contact`)
  whose click runs the **same navigation routine** `applyVoiceToolCall` already uses for voice.
  Voice keeps executing immediately (no button); text offers the button. Same destination code.
- `main.py` is the only place that translates a model tool call into the FE action id; the FE
  is the only place that performs the DOM navigation. One translator, one executor.

**Contract summary (both modalities):**

| tool name | params | required | text → FE | voice → FE |
|---|---|---|---|---|
| `navigate_to_section` | `{ section: enum['home','work','experience'] }` | `section` | action `{id:'navigate', section}` (button) | `applyVoiceToolCall` runs nav immediately |
| `open_contact_form` | `{ subject?, message? }` | — | action `{id:'open-contact', prefill?}` | runs contact dialog immediately |
| `open_resume` | `{}` (PDF download only — see §3) | — | action `{id:'open-resume'}` (download, not default) | download, not default |

### 3. Guided tour — `show_around`

**Decision: a single `show_around` tool, the FE runs the scripted tour.** Rejected the
alternative (agent emits a sequence of `navigate_to_section` calls) because (a) the model would
have to sequence + time scrolls itself across two transports with different execution models
(text = buttons, voice = immediate), (b) it couples narration pacing to token cadence, and (c)
the section order is a site-IA decision, not a per-turn model decision. A single tool keeps the
order and the scroll choreography owned by the FE (and by ADR-0011), and keeps the contract
the same for text and voice.

```
show_around({ focus?: enum['work','experience','contact'] })
```

- `focus` is optional. Omitted → full tour. Present → the tour starts at / emphasizes that
  stop but still runs the ordered sweep.
- **Stop order (owned by ADR-0011's section map):** `home → work → experience → contact`.
- **Narration contract:** the tour narrates **per stop** — the agent says one short sentence
  about each section as the FE scrolls to it. The FE owns the scroll-and-dwell; the agent owns
  the words. The contract is: the FE scrolls to stop N, the model produces the narration for
  stop N, then the FE advances. For voice this is the natural turn-by-turn cadence already in
  place. For text, `show_around` returns a single action `{id:'tour'}` and the assistant reply
  carries the ordered narration; the FE scroll-walks the sections in order while the narration
  is visible. **Open seam — flagged for navigator below.**
- The tour MUST end on `work` or `contact`, **never** the résumé/experience as the terminal
  emphasis (the work leads; see §4 posture).

**Wire shape:**

| tool name | params | text → FE | voice → FE |
|---|---|---|---|
| `show_around` | `{ focus?: enum['work','experience','contact'] }` | action `{id:'tour', focus?}` | `applyVoiceToolCall` runs the scripted tour |

### 4. Résumé behavior change — `open_resume` is NOT the default

Three coordinated changes so the agent leads with the work and the résumé is opt-in:

1. **`open_resume` becomes PDF-download-only and explicit.** Tool description (both
   `providers.py` and `live_gemini.py`) changes from "Open the visitor-facing resume PDF in a
   new tab. Call this when the user asks to see, open, download, or get the resume." to scope
   it to an **explicit download ask only**, e.g.:

   > "Download the résumé PDF. Call this ONLY when the visitor explicitly asks for a PDF /
   > file / download to keep. For 'show me his experience / background / career', do NOT call
   > this — call `navigate_to_section('experience')` to scroll them to the on-page experience
   > section instead. Never call this as an opening or qualification move."

2. **"Show me the résumé / experience / background" scrolls, it does not download.** That
   intent maps to `navigate_to_section('experience')` (scroll to the inline experience section
   from ADR-0011), not `open_resume`. The PDF stays a quiet, explicit download.

3. **System-prompt + knowledge changes** (`docker/chat/prompts/system-prompt.md`, bump
   `prompt-version`; mirror the posture into the optional voice prompt and/or
   `CHAT_VOICE_SYSTEM_APPEND`):
   - Remove "or appears to be doing initial qualification" from the `open_resume` trigger.
   - Add a "Tools available" entry for `navigate_to_section` and `show_around`, and state the
     **lead-with-the-work** rule: when a visitor wants to evaluate Marwan, lead with the work
     (offer the Work showcase / a specific project, or offer to show them around), **not** the
     résumé; only reach for the experience section or the PDF on an explicit ask.
   - State the résumé rule plainly: "Do not open or download the résumé as a default or an
     opening move. For 'tell me about his experience/background', scroll to the experience
     section with `navigate_to_section('experience')`. Only `open_resume()` (PDF download) when
     the visitor explicitly asks for a file to keep."

   `knowledge_context.py` is NOT gated and needs no behavior change for this ADR; if any FAQ
   row carries `trigger_tool: open_resume` for a non-explicit-download question, retarget it to
   `navigate_to_section` (a data edit in `data/chat-knowledge/faq.json`, not code) — flagged for
   the inner loop, not fixed here.

## Consequences

- The text and voice tool surfaces converge: same tool names, same params, one shared section
  vocabulary. `navigate_to_section` and `show_around` exist on both paths; `open_resume` is the
  same narrow download tool on both.
- The FE gains two handler branches (`navigate` action / tour) and a tolerant section resolver
  (new ∪ legacy enum). `applyVoiceToolCall` and the text action handler call the **same**
  navigation + tour routines — no second implementation.
- A model that still emits the pre-merge enum (`portfolio`/`labs`/`playground`) keeps working
  via the FE resolver; no flag-day.
- The résumé stops firing reflexively; the experience section (ADR-0011) becomes the in-flow
  destination for "show me his background", and the PDF is a quiet explicit download.
- Voice telemetry / transcript persistence is unchanged — `navigate_to_section` and
  `show_around` flow through the existing `toolCalls` / `actions` persistence in `main.py`.

### Migration notes

- Bump `prompt-version` in `system-prompt.md` (currently `1.5.0`). `/ready` and persisted turns
  carry `promptVersion`, so the change is observable in the admin panel.
- The new `actions` ids (`navigate`, `tour`) are additive; older FE builds ignore unknown
  action ids (they only branch on known ones), so a backend ahead of the FE degrades to "no
  button" rather than breaking. The FE side ships in the same feature.
- No DynamoDB schema change.

## Implementer clearance (SECURITY_GLOB)

This ADR **is the deliberate security review** clearing the gated chat edits below. The
`SECURITY_GLOB` in `.claude/tdd.config` matches `docker/chat/app/(main|lambda_handler|live_env|
live_gemini).py`. The guide/navigation changes touch **two** gated files; clear them under
`SECURITY_REVIEW=1`, scoped strictly to:

- **`docker/chat/app/live_gemini.py`** — in `_LIVE_TOOLS` only: change the
  `navigate_to_section` enum to `['home','work','experience']`, narrow the `open_resume`
  description (§4), and add the `show_around` function declaration. **No change** to token
  minting, the setup handshake, voice/timbre (ADR-0003), the WSS URL, auth-token config, or any
  network/credential path.
- **`docker/chat/app/main.py`** — in `_actions_from_result` only: map `navigate_to_section` →
  `{id:'navigate', section}` and `show_around` → `{id:'tour', focus?}`, reusing the existing
  `_normalize_tool_args` + dedupe. **No change** to CORS (`_cors_*`), admin/smoke key checks,
  the live-session mint endpoint, request validation, or persistence semantics.

Out of scope for this clearance: anything else on those two files. `providers.py`,
`knowledge_context.py`, `js/chat.js`, and `docker/chat/prompts/system-prompt.md` are **not**
under the glob and need no `SECURITY_REVIEW`.

## Open seam (flagged for navigator)

**Text-path tour pacing.** Voice narrates per stop naturally (turn-by-turn). For the **text**
path the contract above has the model emit the full ordered narration in one reply while the FE
scroll-walks the sections. Two viable resolutions, both compatible with the tool contract — the
navigator should pick before the inner loop builds the FE tour:

- **(A) One-shot:** `show_around` returns `{id:'tour', focus?}`; the assistant reply contains
  the ordered narration as prose; the FE runs a timed scroll sweep (respecting
  `prefers-reduced-motion`, which would collapse to instant jumps). Simplest; narration and
  scroll are loosely coupled.
- **(B) Stepped:** the action payload carries a structured `stops` array
  (`[{section, line}, ...]`) so the FE can sync each scroll to its own narration line. Tighter
  sync, larger contract. If chosen, the `tour` action grows a `stops` field — additive, FE
  ignores it under (A).

Recommendation: ship **(A)** first (smallest contract that lets both sides proceed), leave (B)
as an additive follow-up if pacing feels off in QA.
