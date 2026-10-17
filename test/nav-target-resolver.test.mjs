import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  SECTION_IDS,
  SECTION_ALIASES,
  resolveNavTarget,
  normalizeSection
} from '../js/section-names.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8')

// The section vocabulary becomes DATA in one module (ADR-0015 §2.1), and the agent's
// navigation tool resolves through it instead of matching bytes.
//
// WHY THIS SLICE EXISTS — cause (d) of the five §9 found, MEASURED at js/chat.js:1516-1527:
//
//     if (section === 'home') { ... }
//     else if (section === 'labs' || section === 'playground') { ... }
//     else if (section === 'portfolio') { ... }
//     else { return { error: `unknown_section: ${section}` } }
//
// The match is BYTE-EXACT. `"Portfolio"`, `" portfolio"`, `"Labs"`, `"PLAYGROUND"` all fall
// through to `unknown_section`. No trim, no toLowerCase. A model that capitalises a proper
// noun — which is exactly what a model does with a section called "Portfolio" — fails to
// navigate, and on the text path (js/chat.js:1480) the return value is DISCARDED, so the
// failure is silent to everyone including the model. That discarded return is its own slice;
// this one makes the resolution itself stop being a failure mode.
//
// HALF OF THE PLAN'S CLAIM IS REFUTED, and the test says so rather than inheriting it:
// legacy `playground` does NOT silently fail today — it is handled explicitly on the line
// above. The plan's example was out of date. What actually breaks is case and whitespace.
//
// WHY A REGISTRY RATHER THAN A `trim().toLowerCase()` PATCH. ADR-0015 §2 found two live
// vocabularies: the shipped `home|portfolio|labs` and ADR-0010/0011's accepted-but-unbuilt
// `work|experience|contact`. If M2 writes a third normaliser with its own opinion, whichever
// of M2 / Work-showcase lands second reworks the first. As data in the module that already
// owns the mapping, ADR-0011's rename becomes an edit to SECTION_IDS + SECTION_ALIASES and
// touches nothing M2 builds. That is what makes the two milestones order-independent.
//
// `hash` IS PART OF THE RESULT, not derived by the caller as `'#' + id`, because home is NOT
// a hash: js/navigation.js:88-90 restores the base URL for home and only `#portfolio` /
// `#labs` are real routes. A caller that built the hash itself would write `#home`, which
// navigateByHash (js/navigation.js:62-72) resolves to home by FALLTHROUGH — right answer,
// wrong URL, and a bookmark nobody can explain.

test('resolveNavTarget returns the target the router actually understands', () => {
  assert.deepEqual(resolveNavTarget('portfolio'), { id: 'portfolio', hash: '#portfolio' })
  assert.deepEqual(resolveNavTarget('labs'), { id: 'labs', hash: '#labs' })
  assert.deepEqual(
    resolveNavTarget('home'), { id: 'home', hash: '' },
    "home's hash is EMPTY, not '#home': js/navigation.js:88-90 puts home at the base URL, " +
    'and a caller that assembled the hash itself would invent a route that only works by ' +
    "navigateByHash's fallthrough"
  )
})

test('case and whitespace stop being failure modes', () => {
  // Each of these is `unknown_section` against the shipped byte-exact chain, and each is
  // something a language model plausibly emits for a section the site calls "Portfolio".
  for (const raw of ['Portfolio', ' portfolio', 'portfolio ', 'PORTFOLIO', '\tPortfolio\n']) {
    assert.deepEqual(
      resolveNavTarget(raw), { id: 'portfolio', hash: '#portfolio' },
      `${JSON.stringify(raw)} must resolve. The shipped chain compares bytes, so a ` +
      'capitalised proper noun was a silent navigation failure (ADR-0015 §9.2)'
    )
  }
  assert.deepEqual(resolveNavTarget('Labs'), { id: 'labs', hash: '#labs' })
})

test('the legacy alias resolves, and resolves to the id it is an alias FOR', () => {
  assert.deepEqual(
    resolveNavTarget('playground'), { id: 'labs', hash: '#labs' },
    'playground is a legacy INPUT alias (js/section-names.js) — it must land on labs, and ' +
    'the resolved id must be `labs` so the echoed tool result names the section the visitor ' +
    'is actually looking at, not the word the model happened to use'
  )
  assert.deepEqual(resolveNavTarget('PlayGround'), { id: 'labs', hash: '#labs' })
})

test('an unresolvable section is refused WITH what was received', () => {
  for (const raw of ['work', 'experience', 'contact', 'about', '']) {
    const got = resolveNavTarget(raw)
    assert.equal(got.error, 'unknown_section', `${JSON.stringify(raw)} must not resolve`)
    assert.equal(
      got.received, raw,
      'the refusal must carry the RAW input back. The model is the only party that can ' +
      'correct itself, and it cannot do that from an error that drops the thing it said'
    )
    assert.equal(got.id, undefined, 'a refusal must not also carry an id — callers branch on it')
  }
  // ADR-0010's vocabulary is void (§2): it was conditional on the Portfolio+Labs merge that
  // ADR-0011 proposed and f454481 reverted. `work` resolving would mean M2 shipped it.
})

test('a non-string input is refused, not coerced into a lookup', () => {
  for (const raw of [null, undefined, 42, {}, []]) {
    const got = resolveNavTarget(raw)
    assert.equal(
      got.error, 'unknown_section',
      `${JSON.stringify(raw) ?? String(raw)} must be refused. String(null) is "null" and ` +
      'String([]) is "", so a blind String() coercion turns a caller bug into a plausible ' +
      'lookup miss — and §6.3\'s rule is to reject identities, not clamp them'
    )
  }
})

test('the registry is the single source of truth, in one module', () => {
  assert.deepEqual(
    [...SECTION_IDS], ['home', 'portfolio', 'labs'],
    'SECTION_IDS is the shipped registry (ADR-0015 §2.1). siteState.section is ' +
    'contractually "a member of SECTION_IDS", never a hard-coded union, so the store, the ' +
    'stage reducer and the wire sub-model are all vocabulary-agnostic'
  )
  assert.deepEqual(
    { ...SECTION_ALIASES }, { playground: 'labs' },
    'legacy and future renames land in SECTION_ALIASES — that is what makes ADR-0011 a data ' +
    'edit instead of a rework of everything M2 builds'
  )
  for (const [alias, target] of Object.entries(SECTION_ALIASES)) {
    assert.ok(
      SECTION_IDS.includes(target),
      `alias ${alias} points at ${target}, which is not in SECTION_IDS — an alias to nowhere`
    )
    assert.ok(
      !SECTION_IDS.includes(alias),
      `${alias} is both an id and an alias; one of the two lookups is dead`
    )
  }
})

test('normalizeSection keeps its shipped contract and now shares the registry', () => {
  // Its four consumers (js/chat.js, js/agent-node.js) must not change behaviour, and
  // test/labs-restructure.test.mjs pins the same rows from the other side.
  assert.equal(normalizeSection('labs'), 'labs')
  assert.equal(normalizeSection('playground'), 'labs')
  assert.equal(normalizeSection('portfolio'), 'portfolio')
  assert.equal(normalizeSection('home'), 'home')
  assert.equal(
    normalizeSection('anything-else'), 'home',
    'normalizeSection BUCKETS (unknown -> home) while resolveNavTarget REFUSES. Both are ' +
    'correct for their job: bucketing an analytics label must never throw, and navigating ' +
    'the visitor to the wrong page must never be silent. Same registry, different posture'
  )
})

test('the agent tool declarations draw on this registry rather than a fourth copy', () => {
  // ADR-0015 §2.1, consequence 3: the two Python declarations must be asserted against the
  // SAME registry. docker/chat/tests/test_guide_tool_contract.py already pins them equal to
  // each other and to a hardcoded {home, portfolio, labs} — which is a SECOND copy of the
  // vocabulary, in another language, in a suite that runs separately. Rename SECTION_IDS and
  // that test stays green against the old set. This row is the cross-language link.
  const navEnum = (source) => {
    const m = /name\s*=\s*['"]navigate_to_section['"]/.exec(source)
    assert.ok(m, 'navigate_to_section is not declared in this module')
    const e = /enum\s*=\s*\[([^\]]*)\]/.exec(source.slice(m.index, m.index + 4000))
    assert.ok(e, 'no enum= inside the navigate_to_section declaration')
    return e[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  for (const module of ['providers.py', 'live_gemini.py']) {
    assert.deepEqual(
      navEnum(read('docker', 'chat', 'app', module)).sort(), [...SECTION_IDS].sort(),
      `${module}'s navigate_to_section enum must equal SECTION_IDS. The model on either ` +
      'path is being taught what sections exist; teaching it one the registry does not have ' +
      'is how voice came to be unable to emit `labs` at all'
    )
    assert.ok(
      !navEnum(read('docker', 'chat', 'app', module))
        .some((s) => Object.keys(SECTION_ALIASES).includes(s)),
      `${module} advertises a legacy alias. Aliases are accepted as INPUT so old bookmarks ` +
      'keep working; a declaration that offers one teaches the model a section the site does ' +
      'not have'
    )
  }
})
