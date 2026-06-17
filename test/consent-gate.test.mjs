import test from 'node:test'
import assert from 'node:assert/strict'

// SEC-1 / ADR-0008 Decision 2 — the consent gate is a single chokepoint: until the
// visitor grants consent, NEITHER Google Analytics NOR the first-party beacon may
// emit. Buffering is fine; sending is not. Once consent is granted, both proceed.
//
// site-config.js (imported transitively by both analytics.js and site-events.js)
// reads `document.querySelector(...)` at MODULE-LOAD time, so every browser global
// the modules touch must be stubbed BEFORE we import them. Static imports hoist and
// would run before the stubs, so the modules are loaded via dynamic import().

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

// Install a fresh fake browser environment and capture every send the modules make
// (sendBeacon + the keepalive fetch fallback). Returns the captured sinks + restore.
function installBrowserEnv() {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    crypto: globalThis.crypto,
    fetch: globalThis.fetch,
    dataLayer: globalThis.dataLayer
  }

  const beaconCalls = []
  const fetchCalls = []
  const localStorage = makeStorage()
  const sessionStorage = makeStorage()

  // GA's gtag shim writes via a BARE `dataLayer` identifier (resolves to
  // globalThis.dataLayer) after seeding `window.dataLayer`. In a real browser those
  // are the same object; mirror that here so window.dataLayer and global dataLayer
  // stay one array — otherwise the config push would land somewhere we don't observe.
  globalThis.dataLayer = undefined
  const win = {
    location: { hash: '', pathname: '/', hostname: 'example.test', origin: 'https://example.test' },
    addEventListener() {},
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
    // A resolvable contact-api meta so eventsApiUrl is a real URL — otherwise post()
    // would short-circuit on the empty-URL guard and we'd be proving the wrong thing.
    querySelector: (sel) =>
      sel.includes('gvp:contact-api-url')
        ? { getAttribute: () => 'https://example.test/api/contact' }
        : null,
    querySelectorAll: () => [],
    addEventListener() {}
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
  define('fetch', (...args) => {
    fetchCalls.push(args)
    return Promise.resolve({ ok: true })
  })

  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]
      else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
    }
  }

  return { beaconCalls, fetchCalls, localStorage, win, restore }
}

test('analytics and the first-party beacon do not fire until consent is granted', async () => {
  // Arrange — fresh browser env, consent NOT granted yet.
  const env = installBrowserEnv()
  try {
    // Fresh module instances each run so the beacon buffer / GA dataLayer start clean.
    const bust = `?t=${Date.now()}-${Math.random()}`
    const { hasAnalyticsConsent } = await import(`../js/consent.js${bust}`)
    const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust}`)
    const { initAnalytics } = await import(`../js/analytics.js${bust}`)

    // Default-deny: the predicate is false before any flag is set.
    assert.equal(hasAnalyticsConsent(), false, 'consent must default to denied')

    // Act 1 — without consent: buffer an event, init GA, flush.
    recordEvent('page_view', { section: 'home' })
    initAnalytics()
    flushEvents()

    // Assert 1 — nothing left the page and GA was not configured.
    assert.equal(env.beaconCalls.length, 0, 'no beacon may be sent without consent')
    assert.equal(env.fetchCalls.length, 0, 'no keepalive fetch may be sent without consent')
    const configCalls = (env.win.dataLayer || []).filter((a) => a[0] === 'config')
    assert.equal(configCalls.length, 0, 'gtag("config", …) must not run without consent')

    // Act 2 — visitor grants consent, then init GA and flush the buffered event.
    env.localStorage.setItem(CONSENT_KEY, 'granted')
    assert.equal(hasAnalyticsConsent(), true, 'consent reads true once the flag is granted')
    initAnalytics()
    flushEvents()

    // Assert 2 — now the beacon posts and GA is configured.
    assert.equal(env.beaconCalls.length, 1, 'the buffered event must be sent once consent is granted')
    const configAfter = (env.win.dataLayer || []).filter((a) => a[0] === 'config')
    assert.equal(configAfter.length, 1, 'gtag("config", …) must run once consent is granted')
  } finally {
    env.restore()
  }
})
