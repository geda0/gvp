# ADR-0018 — Component addresses and boundary fences (M5), as an address map

- Status: Accepted, 2026-10-23
- Plan: `docs/plan-2026-09-port.md` M5 ("component addresses + boundary fences")
- Seam owner: architect

## Context

The plan put M5 *before* M2, so that boundary tests would fence the addresses later milestones
wrote into, under an "address-first, relocates nothing" decision. In practice M2, M3 and M7
landed first and M4 is in flight. None of the plan's target directories exist: `js/lib`,
`js/components/*`, `docker/chat/app/{models,voice,assistant}` and `aws/src/admin`.

Building the plan's tree now would mean moving the very files M4 is editing, which buys
conflicts and no behaviour.

## Decision

**The layout is enforced as an address map over the modules where they already live.** Two
fences, each with a table that assigns every module to a component and a rule set over the
real imports:

- `docker/chat/tests/test_component_boundaries.py` reads every import from the AST, including
  imports inside functions.
  - **leaf:** `alerts`, `transcript_store`, `secret_resolver`, `messages`.
  - **models:** `gemini_routing`, `gemini_limit_state`, `upstream_errors`.
  - **voice:** `live_gemini`, `live_env`.
  - **assistant:** `knowledge_context`, `site_state`, `providers`, `turn_input`.
  - **harness:** `main`, `lambda_handler`.

  Rules: leaf → leaf; models → leaf; voice → leaf; assistant → leaf and models; harness →
  anything. The plan's headline rule, "models never import assistant, voice or main", is
  also stated on its own.
- `test/component-boundaries.test.mjs`:
  - **lib:** starfield geometry and preferences, precipitation, theme-time.
  - **components:** assistant, theme, hero, admin.
  - **shell:** app.js and the site plumbing.

  Rules:
  - lib → lib only.
  - A component never imports another component except at a **declared seam**. There are
    three: `spaceman → chat-bus`, `spaceman → theme` and `spaceman-position →
    chat-panel-anim`.
  - Shell does not import components; only `app.js` wires them.
  - **Admin stands alone in both directions.**
  - Every declared seam must still be used, so a dead seam doesn't linger as a stale
    permission.
  - The SDK-free cores in `aws/src/common` (`*-core.js` and `admin-auth.js`) never import
    `@aws-sdk`.

**A module missing from the map fails its fence.** A new file has to be given an address in
the same change that adds it. That is the whole point: placing the module is the design
decision the fence forces.

Both fences pass on the code as it stands. That is a measurement, not a target: the existing
modules already respect the layout. Both were mutation-checked, by a model module importing
`providers` inside a function, and by `theme.js` importing `chat-bus.js`; each was caught and
named.

## Consequences

- No file moved. M4 is undisturbed apart from the address rule: **M4's new modules must be
  added to the address map.**
- If the directories are ever wanted, the map is the move list. Relocating then becomes a
  mechanical change that the fences verify, not a design step.
- Declaring a seam is a reviewed edit with its reason inline, not an import that slips in.
