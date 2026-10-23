import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { makeEl, makeListeners, defineGlobal, settle } from './fixtures/chat-harness.mjs'

// Do the site modules actually WRITE the store, and is the event they replace gone?
//
// ADR-0015 §3.2 assigns one writer per field, and the writer IS the permission:
//
//   section      setSection       js/navigation.js (applySection)
//   project      setProject       js/projects.js
//   contactOpen  setContactOpen   js/contact.js
//   chatStage    setChatStage     js/chat.js only
//   voiceActive  setVoiceActive   js/chat.js only
//   js/app.js writes NOTHING — it is the wiring module, and its collapseChatDialog() call
//   (the §9.1 teardown) is deleted.
//
// WHY THE EVENT IS REMOVED AND NOT ADAPTED (§3.6). `gvp:site-chat-collapse` had exactly two
// emitters (js/projects.js:228, js/contact.js:77) and one listener (js/chat.js), whose body
// was `closePanel({ restoreFocus: false, immediate: true })`. Both emitters are the same
// modules that become the writers here, so converting them is the edit §3 already requires.
// An adapter for a three-call-site in-repo event is carrying cost, and here it is actively
// dangerous: a surviving emitter still reaches snapClose, which silently restores the defect
// the whole milestone is about.
//
// THE GREP ROW IS DELIBERATE, not laziness. The failure mode is a LEFTOVER EMITTER, and no
// behavioural test on the new store can see one — the store simply never hears about it.
// Same technique as test/frontend-no-secrets.test.mjs.
//
// ORIGIN IS NOT DECORATION HERE. §3.3: 'agent' means a tool call the model made caused this,
// 'system' is boot and viewport, 'visitor' is everything the person did. An agent-caused and
// a visitor-caused change are byte-identical in the state, so §7's live note can only avoid
// echoing the agent's own action back at it — which it already learned from the tool result
// — by reading origin. A default would quietly mislabel exactly the writes that matter, so
// the store demands it (test/site-state.test.mjs pins the throw).

const REPO = fileURLToPath(new URL('..', import.meta.url))

function installStubDom({ hash = '' } = {}) {
  const byId = new Map()
  const docEvents = makeListeners()
  const winEvents = makeListeners()
  const getEl = (id) => {
    if (!byId.has(id)) byId.set(id, makeEl('div'))
    return byId.get(id)
  }
  const location = {
    protocol: 'http:', hostname: 'portfolio.test', pathname: '/', search: '', hash,
    origin: 'http://portfolio.test'
  }
  defineGlobal('document', {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    activeElement: makeEl('div'),
    visibilityState: 'visible',
    getElementById: getEl,
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => docEvents.add(type, fn),
    removeEventListener: (type, fn) => docEvents.remove(type, fn)
  })
  defineGlobal('window', {
    isSecureContext: true,
    gtag: () => {},
    location,
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo () {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type, fn) => winEvents.add(type, fn),
    removeEventListener: (type, fn) => winEvents.remove(type, fn),
    dispatchEvent: (event) => {
      winEvents.fire(String(event?.type || ''), event)
      return true
    }
  })
  defineGlobal('history', {
    replaceState (_state, _title, url) {
      if (typeof url === 'string') location.hash = url.startsWith('#') ? url : ''
    }
  })
  defineGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0))
  defineGlobal('cancelAnimationFrame', (id) => clearTimeout(id))
  return { getEl, location, winEvents }
}

/**
 * A fresh copy of the module under test, talking to the ONE store.
 *
 * The cache-buster goes on the module under test only. These modules are singletons
 * (`dialogBootstrapped`, the `requestNavigationImpl` hook, `initContactForm`'s closures) so
 * each test needs its own — but a busted specifier resolves its own `./site-state.js` import
 * to the UNBUSTED one, so the store stays a single instance. That is both what the browser
 * has and what lets a subscriber here see the module's writes. The first version of this
 * helper busted the store too, and every row came back with zero changes: the test was
 * watching a different store than the code wrote to.
 */
async function freshModules (tag) {
  const siteState = await import('../js/site-state.js')
  siteState.__resetSiteStateForTests()
  return { siteState, bust: `?${tag}=${Math.random()}` }
}

test('js/navigation.js writes section, and labels boot as system', async () => {
  const { getEl, location, winEvents } = installStubDom({ hash: '#portfolio' })
  const { siteState, bust } = await freshModules('nav')
  const { initNavigation } = await import('../js/navigation.js' + bust)

  const changes = []
  siteState.subscribe((_snap, change) => { if (change) changes.push(change) })

  // initNavigation's last act is navigateByHash() (js/navigation.js:95) — one boot read of
  // the URL, which is neither the visitor nor the agent doing something.
  initNavigation({ onStateChange: () => {} })
  await settle()

  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]),
    [['section', 'portfolio', 'system']],
    "boot must write the section it resolved from the URL, with origin 'system'. §3.3 " +
    'reserves system for boot and viewport-driven changes precisely so §7 does not announce ' +
    'the page the visitor arrived on as though they had just navigated there'
  )

  // A nav click is the visitor.
  changes.length = 0
  getEl('labsNav').events.fire('click', { preventDefault () {} })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]),
    [['section', 'labs', 'visitor']],
    'a nav link click is a VISITOR act'
  )

  // And a hashchange the visitor caused (back button, pasted URL) is also the visitor.
  changes.length = 0
  location.hash = '#portfolio'
  winEvents.fire('hashchange', { type: 'hashchange' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]),
    [['section', 'portfolio', 'visitor']],
    'a hashchange with no agent request behind it is the visitor (back button, pasted link)'
  )
})

test('navigation exposes requestNavigation, so the agent is not poking the URL', async () => {
  // ADR-0015 §5.1's read-back needs the router to have RUN, and the no-op hash write (§9.4)
  // is only invisible from inside chat.js — which is where it lived. Routing belongs to the
  // router: chat.js asks, navigation.js moves the page and labels the write 'agent'.
  const { location } = installStubDom({ hash: '' })
  const { siteState, bust } = await freshModules('req')
  const { initNavigation, requestNavigation } = await import('../js/navigation.js' + bust)
  initNavigation({ onStateChange: () => {} })
  await settle()

  const changes = []
  siteState.subscribe((_snap, change) => { if (change) changes.push(change) })

  const ok = requestNavigation('Portfolio', { origin: 'agent' })
  await settle()
  assert.deepEqual(
    ok, { id: 'portfolio', hash: '#portfolio' },
    'requestNavigation resolves through the registry and reports the target it moved to'
  )
  assert.equal(location.hash, '#portfolio', 'and it must move the URL, not just the state')
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]),
    [['section', 'portfolio', 'agent']],
    "an agent-driven navigation must be labelled 'agent'. This is the whole reason origin " +
    'exists: §7 must not read the agent its own action back'
  )

  // The no-op case (§9.4): already there, so a hash assignment would dispatch nothing.
  changes.length = 0
  const again = requestNavigation('portfolio', { origin: 'agent' })
  assert.deepEqual(
    again, { id: 'portfolio', hash: '#portfolio' },
    'navigating to where the visitor already is must SUCCEED, not error — it is a no-op in ' +
    'the DOM but a true statement about where the page is, and §5.1 needs the tool result to ' +
    'be true rather than merely non-empty'
  )
  assert.deepEqual(
    changes, [],
    'and it must not notify: the store already holds that section, and a same-value write ' +
    'is a no-op (§3.4). Without this the live session is told about a change that did not ' +
    'happen every time the model re-navigates to the current page'
  )

  assert.deepEqual(
    requestNavigation('work', { origin: 'agent' }),
    { error: 'unknown_section', received: 'work' },
    "an unresolvable section is refused by the router too — ADR-0010's vocabulary never " +
    'shipped (§2), and the refusal must carry back what was received'
  )
})

test('js/contact.js writes contactOpen on open and on close', async () => {
  const { getEl } = installStubDom()
  const { siteState, bust } = await freshModules('contact')
  const contact = await import('../js/contact.js' + bust)
  contact.initContactForm()
  await settle()

  const changes = []
  siteState.subscribe((_snap, change) => { if (change) changes.push(change) })

  contact.openContactDialog({ subject: 'Hiring', message: 'Hello' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]), [['contactOpen', true, 'visitor']],
    'opening the contact dialog is a state change, not a command to the chat. That is the ' +
    'inversion the milestone is about: the event said "collapse the chat", so every listener ' +
    'could only obey; the state says "the form is open", and the chat decides what that means'
  )

  changes.length = 0
  getEl('contactDialog').querySelector('.contact-dialog__close').events
    .fire('click', { type: 'click' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]), [['contactOpen', false, 'visitor']],
    'and CLOSING must write too. Without the false write the chat never gets its stage back ' +
    '— a visitor who opens the form and closes it again is left with a pill and nowhere for ' +
    'an assistant mid-sentence to speak from (the return path, ADR-0015 §4.3)'
  )
})

test('js/projects.js writes project on open and null on close', async () => {
  const { getEl } = installStubDom({ hash: '#labs' })
  const { siteState, bust } = await freshModules('proj')
  const projects = await import('../js/projects.js' + bust)

  projects.renderProjects('labsContent', [
    { id: 'team-tactics', title: 'Team Tactics', description: '<p>A TDD harness.</p>' }
  ], 'labsProjects')
  projects.initProjectDetailDialog()
  await settle()

  const changes = []
  siteState.subscribe((_snap, change) => { if (change) changes.push(change) })

  // A card activation, the way a visitor does it. The selector is `.project` — the one
  // js/projects.js:249 actually uses, not the `.project-card` a reader would guess.
  const card = makeEl('article')
  card.getAttribute = (name) => (name === 'data-project-id' ? 'team-tactics' : null)
  const activations = getEl('labsContent').events.fire('click', {
    target: { closest: (sel) => (sel === '.project' ? card : null) }
  })
  assert.ok(activations > 0, 'harness: the card click handler must be bound, or this is blind')
  await settle()

  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]),
    [['project', { id: 'team-tactics', title: 'Team Tactics' }, 'visitor']],
    'the open project is state. It carries the TITLE as well as the id because §7\'s live ' +
    'note has to be sayable — "you are looking at Team Tactics" needs the words, and an ' +
    'assistant that has to look up an id mid-sentence is an assistant that pauses'
  )

  changes.length = 0
  getEl('projectDialog').querySelector('.project-dialog__close').events
    .fire('click', { type: 'click' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]), [['project', null, 'visitor']],
    'closing clears it — same return-path argument as the contact dialog'
  )
})

test('the contact dialog reports WHO opened it, not always the visitor', async () => {
  // Found by the M2 critic pass. js/contact.js hardcoded `origin: 'visitor'`, and
  // openContactFromChat (js/chat.js) calls openContactDialog() with no way to say
  // otherwise — so an AGENT-caused contact open was labelled as the visitor's doing.
  //
  // That is not cosmetic. §7.1's dedupe is "never notify on an agent-origin change, because
  // the agent already received it in the tool result". Mislabelled, the model gets the same
  // fact twice during a live call: once in the tool result's siteState and again ~250 ms
  // later as a clientContent note. §3.3's entire justification for mandatory origin IS this
  // case — and the mechanism was being defeated at the call site while the store's own
  // throw looked like it was holding the line.
  const { getEl } = installStubDom()
  const { siteState, bust } = await freshModules('contact-origin')
  const contact = await import('../js/contact.js' + bust)
  contact.initContactForm()
  await settle()

  const changes = []
  siteState.subscribe((_snap, change) => { if (change) changes.push(change) })

  contact.openContactDialog(null, { origin: 'agent' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]), [['contactOpen', true, 'agent']],
    "an agent-opened contact form must be labelled 'agent'"
  )

  // A visitor closing it afterwards is still the visitor: origin travels with the ACT, not
  // with the dialog.
  changes.length = 0
  getEl('contactDialog').querySelector('.contact-dialog__close').events
    .fire('click', { type: 'click' })
  await settle()
  assert.deepEqual(
    changes.map((c) => [c.field, c.to, c.origin]), [['contactOpen', false, 'visitor']]
  )

  // And the default stays the visitor, because every other door into this dialog is theirs.
  changes.length = 0
  contact.openContactDialog()
  await settle()
  assert.deepEqual(changes.map((c) => c.origin), ['visitor'])
})

test('gvp:site-chat-collapse is GONE from js/, not adapted', () => {
  // RECURSIVE. readdirSync without it is flat, and M5 moves js/ into js/lib + js/components
  // (plan §M5) — at which point a surviving emitter in a subdirectory is invisible to the
  // grep that §3.6 says is its only possible referee.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  ))
  const offenders = []
  for (const file of walk(join(REPO, 'js'))) {
    const name = file.slice(join(REPO, 'js').length + 1)
    if (!name.endsWith('.js')) continue
    const source = readFileSync(file, 'utf8')
    for (const [i, line] of source.split('\n').entries()) {
      // The explanatory references in js/site-state.js are the record of WHY it went; a
      // dispatch or a listener is the defect. Distinguish by looking for live code.
      if (!line.includes('site-chat-collapse')) continue
      const commented = /^\s*(\/\/|\*|\/\*)/.test(line)
      if (!commented) offenders.push(`js/${name}:${i + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(
    offenders, [],
    'a live reference to gvp:site-chat-collapse survives. ADR-0015 §3.6: REMOVED, not ' +
    'adapted. A surviving emitter still reaches closePanel -> snapClose -> stopVoice and ' +
    'silently restores the §9.1 teardown, and no behavioural test on the new store can see ' +
    'it — the store simply never hears about the event. Hence this grep.\n  ' +
    offenders.join('\n  ')
  )
})

test('js/app.js no longer tears the chat down on navigation', async () => {
  // ASSERT THE SEAM, not the formatting. This row used to be a regex anchored to the start
  // of a line, so re-adding the teardown exactly as it was — but on one line, as
  // `if (state === 'portfolio' || state === 'labs') collapseChatDialog()` — was invisible
  // to it, and so was `chat.collapseChatDialog()`. js/app.js is never executed by any test
  // (the harness wires initNavigation straight to syncChatLaunchers), so this was the only
  // guard on the module that held the original defect, and it was guarding whitespace.
  //
  // The export existing at all is what makes the teardown re-addable, so that is the fact
  // to pin: no entry point means no call site, whatever its formatting.
  const chat = await import('../js/chat.js')
  assert.equal(
    typeof chat.collapseChatDialog, 'undefined',
    'js/chat.js must export no collapse-the-panel entry point. While one exists, any module ' +
    'can reach closePanel -> snapClose -> stopVoice again, and the stage decision stops ' +
    'being the reducer\'s (§3.2: app.js writes nothing and commands nothing — it wires)'
  )

  // Comment lines stripped first: js/app.js keeps a note recording what was removed and
  // why, and a bare match on the name fails on the explanation — the same mention-vs-call
  // trap that made an earlier row in this milestone fail on its own doc comment. The fix
  // for that failure would have been to delete the explanation, which is backwards.
  const app = readFileSync(join(REPO, 'js', 'app.js'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.doesNotMatch(
    app, /collapseChatDialog/,
    'js/app.js:243 is the §9.1 teardown\'s first link, and §3.2 says app.js writes nothing ' +
    'and commands nothing: it wires. The stage decision belongs to the reducer, driven by ' +
    'the store — not to a guarded if in the navigation callback (and the guard is why ' +
    '"collapses on every navigation" was false: navigating HOME never collapsed anything)'
  )
})
