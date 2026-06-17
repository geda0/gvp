import test from 'node:test'
import assert from 'node:assert/strict'

// S15 (FE-4) — every contact submit must end on a TERMINAL funnel event.
//
// The submit handler in js/contact.js mirrors GA events through trackEvent ->
// recordEvent (js/site-events.js), which buffers and only beacons after consent.
// So we assert via the public seam the rest of the FE suite uses: install a fake
// browser env that captures sendBeacon calls, drive a submit, grant consent, flush,
// and read the funnel events back off the captured beacon blob.
//
// The bug this guards: a 2xx response whose body is missing/non-object or whose
// content-type is not JSON sets an error STATUS but historically returned WITHOUT
// emitting any terminal event — leaving that submit with no terminal outcome.
//
// site-config.js (imported transitively) reads document.querySelector(...) at
// MODULE-LOAD time, so every browser global the modules touch must be stubbed
// BEFORE we import them. Static imports hoist and would run before the stubs, so
// the modules are loaded via a cache-busted dynamic import().

const CONSENT_KEY = 'gvp-analytics-consent'

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  }
}

// A tiny DOM node: an EventTarget that also carries the attributes/children the
// contact submit handler touches (hidden, dataset, textContent, querySelector*).
function makeNode(extra = {}) {
  const node = new EventTarget()
  node.hidden = false
  node.dataset = {}
  node.textContent = ''
  node.value = ''
  node.disabled = false
  node.classList = { add() {}, remove() {} }
  node.focus = () => {}
  node.reset = () => {}
  node.querySelector = () => null
  node.querySelectorAll = () => []
  node.getAttribute = () => null
  node.setAttribute = () => {}
  Object.assign(node, extra)
  return node
}

// Build the minimal contact DOM the handler resolves by id, plus the form whose
// fields back the FormData read. `formValues` seeds name/email/subject/message/company.
function makeContactDom(formValues) {
  const fieldByName = {}
  for (const name of ['name', 'email', 'subject', 'message', 'company']) {
    const field = makeNode({ name, value: formValues[name] ?? '' })
    fieldByName[name] = field
  }

  const form = makeNode({
    querySelector: (sel) => {
      const m = /name="([^"]+)"/.exec(sel)
      return (m && fieldByName[m[1]]) || null
    },
    querySelectorAll: () => Object.values(fieldByName)
  })

  const backdrop = makeNode()
  const closeBtn = makeNode()
  const dialog = makeNode({
    querySelector: (sel) =>
      sel.includes('backdrop') ? backdrop : sel.includes('close') ? closeBtn : null
  })

  const byId = {
    contactDialog: dialog,
    contactForm: form,
    contactStatus: makeNode(),
    contactSuccessView: makeNode(),
    contactSuccessText: makeNode(),
    contactSendAnotherBtn: makeNode(),
    contactCloseBtn: makeNode(),
    footerOpenContactBtn: makeNode()
  }

  return { byId, form, fieldByName }
}

// Install a fake browser env, a fetch that returns `fetchResponse`, and capture
// every beacon. Returns sinks + restore.
function installBrowserEnv({ formValues, fetchResponse }) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    crypto: globalThis.crypto,
    fetch: globalThis.fetch,
    FormData: globalThis.FormData,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    dataLayer: globalThis.dataLayer
  }

  const beaconCalls = []
  const localStorage = makeStorage()
  const sessionStorage = makeStorage()
  const dom = makeContactDom(formValues)

  globalThis.dataLayer = undefined
  const win = {
    location: { hash: '', pathname: '/contact', hostname: 'example.test', origin: 'https://example.test' },
    addEventListener() {},
    dispatchEvent() {},
    gtag: undefined,
    get dataLayer() {
      return globalThis.dataLayer
    },
    set dataLayer(v) {
      globalThis.dataLayer = v
    }
  }

  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

  define('window', win)
  define('document', {
    getElementById: (id) => dom.byId[id] || null,
    // contact-api meta so eventsApiUrl is real — otherwise post() short-circuits.
    querySelector: (sel) =>
      sel.includes('gvp:contact-api-url')
        ? { getAttribute: () => 'https://example.test/api/contact' }
        : null,
    querySelectorAll: () => [],
    addEventListener() {},
    get body() {
      return { classList: { add() {}, remove() {} } }
    },
    get activeElement() {
      return null
    }
  })
  define('navigator', {
    sendBeacon: (url, blob) => {
      beaconCalls.push({ url, blob })
      return true
    }
  })
  define('localStorage', localStorage)
  define('sessionStorage', sessionStorage)
  define('crypto', { randomUUID: () => 'fixed-session-id' })
  define('fetch', () => Promise.resolve(fetchResponse))
  // FormData(form) reads the seeded field values via form.querySelector.
  define('FormData', class {
    constructor(form) {
      this._form = form
    }
    get(name) {
      const field = this._form.querySelector(`[name="${name}"]`)
      return field ? field.value : null
    }
  })
  define('requestAnimationFrame', (cb) => cb())

  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]
      else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
    }
  }

  return { beaconCalls, localStorage, dom, restore }
}

// A 2xx Response-like whose headers advertise content-type `contentType` and whose
// json() resolves to `body`.
function makeResponse({ contentType, body }) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: () => Promise.resolve(body)
  }
}

const bust = () => `?t=${Date.now()}-${Math.random()}`

async function readBeaconPayload(beaconCall) {
  return JSON.parse(await beaconCall.blob.text())
}

// Wire up the contact form against `env`, dispatch a submit, grant consent, flush,
// and return the funnel events that left the page on the beacon.
//
// contact.js is loaded cache-busted (fresh handler each test), but a busted ENTRY
// module imports its deps via their PLAIN specifiers, so contact -> analytics ->
// site-events all resolve to the CANONICAL (unbusted) site-events instance. So we
// read/flush that same canonical buffer — and drain any leftover from a prior test
// first so each test only sees its own events.
async function submitAndCollectEvents(env) {
  env.localStorage.setItem(CONSENT_KEY, 'granted')
  const { flushEvents } = await import('../js/site-events.js')
  flushEvents() // drain anything a prior test left in the shared buffer
  env.beaconCalls.length = 0

  const { initContactForm } = await import(`../js/contact.js${bust()}`)
  initContactForm()
  env.dom.form.dispatchEvent(new Event('submit'))
  // Let the async submit handler settle (fetch + json are resolved promises).
  await new Promise((r) => setImmediate(r))

  flushEvents()
  if (!env.beaconCalls.length) return []
  const payload = await readBeaconPayload(env.beaconCalls[0])
  return payload.events.map((e) => ({ event: e.event, params: e.params }))
}

test('a 2xx reply with a non-object body emits a terminal unexpected_reply funnel event', async () => {
  const env = installBrowserEnv({
    formValues: { email: 'a@b.test', message: 'hi' },
    fetchResponse: makeResponse({ contentType: 'application/json', body: null })
  })
  try {
    const events = await submitAndCollectEvents(env)
    const names = events.map((e) => e.event)
    assert.ok(names.includes('contact_submit'), 'the in-flight contact_submit must still be emitted')
    const terminal = events.find((e) => e.event === 'contact_submit_error')
    assert.ok(terminal, 'a 2xx with a non-object body must emit a terminal contact_submit_error')
    assert.equal(
      terminal.params.reason,
      'unexpected_reply',
      'the terminal event must carry reason:"unexpected_reply"'
    )
    assert.ok(
      !names.includes('contact_submit_ok'),
      'a malformed 2xx reply must NOT be reported as a success'
    )
  } finally {
    env.restore()
  }
})

test('a 2xx reply with a non-JSON content-type emits a terminal unexpected_reply funnel event', async () => {
  const env = installBrowserEnv({
    formValues: { email: 'a@b.test', message: 'hi' },
    // 2xx but the body parses as an object — the failure is the content-type alone.
    fetchResponse: makeResponse({ contentType: 'text/html', body: { ok: true } })
  })
  try {
    const events = await submitAndCollectEvents(env)
    const names = events.map((e) => e.event)
    const terminal = events.find((e) => e.event === 'contact_submit_error')
    assert.ok(terminal, 'a 2xx with a non-JSON content-type must emit a terminal contact_submit_error')
    assert.equal(
      terminal.params.reason,
      'unexpected_reply',
      'the terminal event must carry reason:"unexpected_reply"'
    )
    assert.ok(
      !names.includes('contact_submit_ok'),
      'a non-JSON 2xx reply must NOT be reported as a success'
    )
  } finally {
    env.restore()
  }
})

test('a well-formed 2xx JSON reply still emits the success terminal event, not an error', async () => {
  const env = installBrowserEnv({
    formValues: { email: 'a@b.test', message: 'hi' },
    fetchResponse: makeResponse({ contentType: 'application/json', body: { ok: true } })
  })
  try {
    const events = await submitAndCollectEvents(env)
    const names = events.map((e) => e.event)
    assert.ok(names.includes('contact_submit_ok'), 'a clean 2xx JSON reply must emit contact_submit_ok')
    assert.ok(
      !names.includes('contact_submit_error'),
      'a clean success must NOT also emit a contact_submit_error'
    )
  } finally {
    env.restore()
  }
})
