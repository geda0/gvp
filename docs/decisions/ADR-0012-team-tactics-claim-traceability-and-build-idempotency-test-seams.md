# ADR 0012 — Test seams for Team Tactics claim-traceability (AC-3) and build idempotency (AC-5)

- Status: Accepted
- Date: 2026-06-18
- Deciders: architect (consulted by orchestrator); navigator/owner to note (defaults stand)
- Scope: app-layer `node:test` suite (`test/*.test.mjs`, run SDK-free on a clean checkout per
  `.claude/tdd.config`). Test-design seam only — NOT a new architecture.
- Relates to: ADR 0005 (two-layer TDD harness). Design notes "Team Tactics redo" AC-3 + AC-5.

## Context

Two new high-value guards are being added for the `team-tactics` portfolio entry:

- **AC-3 (claim traceability):** the project copy/tags claim a "hand-rolled MCP server",
  "zero-dependency / no SDK", exposing exactly 7 tools (`tic_emit`, `tics_log`, `tics_inbox`,
  `tics_board`, `tics_review`, `tics_answer`, `tics_map`). The PO proposes the test READ the live kit
  file `.claude/hooks/tics-mcp.cjs` and assert (a) no third-party `require()` / no
  `@modelcontextprotocol` SDK, (b) the 7 tool names are present — so the marketing claim can't drift
  from the code.
- **AC-5 (build idempotency):** assert `npm run build:chat-knowledge` is a no-op on committed state
  and that `resume-access` stays `navigate_to_section`.

Two seam questions were referred to the architect:

1. Is it a clean seam for the **product's** app-layer suite to treat a **kit/tooling** file
   (`.claude/hooks/tics-mcp.cjs`) as the source of truth for a product marketing claim — or should the
   claim be pinned by a committed human-maintained fixture?
2. For AC-5, is shelling out to the build (`node scripts/build-chat-knowledge.mjs`) from a unit test
   acceptable, or should idempotency be asserted a cheaper way?

Verified facts that drive the decision:

- `.claude/hooks/tics-mcp.cjs` is committed and present on a clean checkout. Its only `require()`s are
  Node builtins (`fs`, `path`, `child_process`) + the sibling kit file `tics-view.cjs`. The 7 tool names
  live in `TOOL_DESCRIPTORS` and the dispatch switch. It is a **generated kit file** (`/* generated kit */`
  banner) refreshed by `ttics` upgrades — its internal shape is NOT owned by this product.
- `scripts/build-chat-knowledge.mjs` exports **nothing**: `FAQ`, `buildRoles`, `buildProjects`, and
  `writeJson` are all module-private and the module runs `main()` (writes four files) as a top-level
  side effect on import. There is no pure builder a test can import today.

## Decision

### AC-3 — claim traceability: assert the claim, not the kit's internals (committed fixture + a narrow live tripwire)

Pin the marketing claim with a **committed fixture** that a human updates deliberately
(`test/fixtures/team-tactics-claims.json`): the canonical 7 tool names, the headline tags
("Hand-rolled MCP server", "JSON-RPC 2.0", "Zero-dependency"), and the "no third-party require / no SDK"
invariant. The product test asserts the **copy/tags agree with the fixture** — that is the product
contract.

Keep a **single narrow live tripwire** against `.claude/hooks/tics-mcp.cjs`, guarded so a kit refactor
degrades gracefully rather than reddening the product suite on an unrelated change:

- If the file is absent (someone runs the product suite without the kit), the tripwire **skips** (`t.skip`),
  it does not fail. The product contract (copy ↔ fixture) still holds without the kit.
- When present, assert only the **load-bearing, slow-moving** facts the claim rests on, matched
  tolerantly (not against line numbers or exact descriptor formatting):
  - every tool name in the fixture appears in the file (substring/identifier match), and no claimed tool
    is missing — catches the copy naming a tool the server dropped;
  - no `require(` resolves to a third-party package — assert the require targets are Node builtins or a
    relative/`__dirname` sibling path (the "no SDK / zero-dependency" invariant), and there is no
    `@modelcontextprotocol` import.

Rationale: the product's contract is "the copy tells the truth," and the durable truth is the small set
of facts in the fixture — not the kit's file layout. The fixture gives drift-protection where it
matters (a human must consciously change the claimed tool set or the no-SDK promise), and the skipping
tripwire keeps the live-read drift-catch (the kit actually losing a tool or gaining a dependency) WITHOUT
coupling the product suite to generated-kit internals that an upstream `ttics` upgrade can reshape at any
time. Two failure modes, two owners: copy-vs-fixture is the product's; fixture-vs-kit is a deliberate
human reconciliation when the kit changes.

### AC-5 — build idempotency: assert byte-stability against committed artifacts; do NOT shell out (and do NOT re-derive)

Assert idempotency by reading the **committed** `data/chat-knowledge/*.json` and proving a rebuild would
not change them — WITHOUT spawning the builder and WITHOUT re-implementing the builder in the test:

- **Preferred (small refactor, file the drift for the loop):** make `scripts/build-chat-knowledge.mjs`
  export its pure builders (`FAQ`, `buildRoles(resume)`, `buildProjects(projects)`) and the
  serializer it uses (`JSON.stringify(value, null, 2) + '\n'`), and guard the `main()` side effect behind
  an `import.meta.main`-style check (or move `main()` to a thin CLI wrapper) so importing the module is
  pure. The test then imports the builders, reads the same source inputs the builder reads
  (`resume/resume.json`, `data/projects.json`, `data/chat-knowledge/bio.source.json`), recomputes each
  payload in-process, and `assert.deepEqual`s the serialized result against the committed file. This is
  the honest idempotency proof: same inputs + the REAL builder code ⇒ byte-identical committed output,
  no subprocess, fast, deterministic.
- **Do NOT** assert idempotency by copying the FAQ/build logic into the test — that only proves the test
  agrees with itself, not that the committed artifact matches the builder.
- **Do NOT** shell out (`node scripts/...`) as the primary assertion: a unit test that writes into the
  working tree is a stateful side effect (it mutates `data/chat-knowledge/`, can leave the tree dirty on
  failure, and couples the test to process spawn + cwd). The clean-checkout, SDK-free floor
  (`node --test`) should stay pure-read.
- Pin the **specific** regression explicitly on top of the byte-equality: the recomputed `faq.json`
  `resume-access` entry carries `trigger_tool: "navigate_to_section"` (NOT `open_resume`) — a named
  assertion so the red test names the latent bug, independent of the broader byte-equality check.

If the loop decides the export-refactor is out of scope for this slice, the acceptable fallback is a
**read-only** idempotency check that imports the module in a sandbox writing to a temp `outputDir` (env
or arg override) and diffs temp output against committed — still no in-tree write, still the real builder.
The non-negotiable invariant is: **prove committed == builder output using the builder's own code, with
no write into the committed tree.**

The build-script refactor (export pure builders / gate the side effect) is **drift to fix in the loop**,
not something the architect implements here. Filed for the implementer.

## Consequences

- New committed fixture `test/fixtures/team-tactics-claims.json` becomes a deliberate human-edited
  source of truth; changing the claimed tool set or the no-SDK promise is a conscious edit, reviewable in
  isolation. (Test-writer authors the fixture + tests; architect does not.)
- The product app-suite does NOT hard-depend on a generated-kit file. A `ttics` upgrade that reshapes
  `tics-mcp.cjs` formatting won't redden the product suite; a kit change that actually drops a tool or
  adds a dependency still trips the live tripwire (when the kit is present).
- AC-5 requires a small refactor to `scripts/build-chat-knowledge.mjs` (export builders + gate
  `main()`), enabling an in-process, side-effect-free idempotency proof. This also makes the builder
  unit-testable in general. Filed as drift for the loop.
- The clean-checkout test floor stays pure-read (no subprocess, no in-tree writes), preserving the ADR
  0005 two-layer harness property that the app layer runs SDK-free and side-effect-free.

## Invariants worth recording (for `docs/tdd/project-invariants.md`)

1. **Product test suites depend on PRODUCT artifacts, not generated-kit internals.** A claim about the
   kit is pinned by a committed product-owned fixture; any live read of a `.claude/hooks/*` kit file is a
   skip-if-absent tripwire that asserts only slow-moving facts, never file layout.
2. **Idempotency is proven with the builder's own code against committed output — never by shelling out
   from a unit test and never by re-deriving the logic in the test.** Build scripts that a test must
   exercise expose pure builders and gate their CLI side effect; the app-layer floor performs no in-tree
   writes.
3. **`resume-access` ⇒ `navigate_to_section`** (not `open_resume`) in both the `FAQ` const and committed
   `faq.json`; pinned by a named test, independent of the byte-equality check.
