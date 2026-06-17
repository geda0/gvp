import test from 'node:test'
import assert from 'node:assert/strict'

// FE-3 (S14) + TC-02 (S27) — the first-party beacon (js/site-events.js).
//
// getSessionId() is PRIVATE; its only observable effect is the `sessionId` it
// stamps onto the POST payload that flushEvents() sends. So every assertion here
// drives the public contract: record an event, flush, and read the sessionId /
// shape off the captured beacon blob.
//
// site-config.js (imported transitively) reads document.querySelector(...) at
// MODULE-LOAD time, so every browser global the module touches must be stubbed
// BEFORE we import it. Static imports hoist and would run before the stubs, so
// the module is loaded via a cache-busted dynamic import().
//
// There is no consent gate: flushEvents() posts unconditionally, so no test seeds
// any consent flag before flushing.

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  }
}

// A sessionStorage whose getItem/setItem THROW — models storage disabled/blocked
// (private mode, hardened browsers, a quota error). getSessionId() must fall back
// to a FRESH random id, not collapse to a shared constant.
function makeThrowingStorage() {
  return {
    getItem() {
      throw new Error('sessionStorage is blocked')
    },
    setItem() {
      throw new Error('sessionStorage is blocked')
    },
    removeItem() {
      throw new Error('sessionStorage is blocked')
    },
    clear() {
      throw new Error('sessionStorage is blocked')
    }
  }
}

// Install a fake browser env and capture every beacon. `sessionStorage` and
// `crypto.randomUUID` are injectable so a test can vary the storage behavior and
// give each load a distinct UUID (mirroring a real per-load random id).
function installBrowserEnv({ sessionStorage, randomUUID } = {}) {
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
  const session = sessionStorage || makeStorage()
  let uuidSeq = 0
  const uuid = randomUUID || (() => `uuid-${++uuidSeq}`)

  globalThis.dataLayer = undefined
  const win = {
    location: { hash: '', pathname: '/', hostname: 'example.test', origin: 'https://example.test' },
    addEventListener() {}
  }

  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })

  define('window', win)
  define('document', {
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
  define('sessionStorage', session)
  define('crypto', { randomUUID: uuid })
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

  return { beaconCalls, fetchCalls, localStorage, session, win, restore }
}

const bust = () => `?t=${Date.now()}-${Math.random()}`

// Read the JSON payload back off a captured beacon blob.
async function readBeaconPayload(beaconCall) {
  return JSON.parse(await beaconCall.blob.text())
}

// Load a fresh beacon module instance against a given env, record one event, flush,
// and return the single beacon payload that left the page (no consent flag needed).
async function emitOneAndFlush(env) {
  const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust()}`)
  recordEvent('project_interaction', { project_id: 'gvp' })
  flushEvents()
  assert.equal(env.beaconCalls.length, 1, 'expected exactly one beacon to be sent')
  return readBeaconPayload(env.beaconCalls[0])
}

test('getSessionId returns a fresh random id per page load when sessionStorage throws, not a shared constant', async () => {
  // Arrange — two independent "page loads", each with a sessionStorage that throws
  // and its own distinct crypto.randomUUID (a real browser mints a new one per load).
  const loadA = installBrowserEnv({
    sessionStorage: makeThrowingStorage(),
    randomUUID: () => 'random-load-A'
  })
  let payloadA
  try {
    payloadA = await emitOneAndFlush(loadA)
  } finally {
    loadA.restore()
  }

  const loadB = installBrowserEnv({
    sessionStorage: makeThrowingStorage(),
    randomUUID: () => 'random-load-B'
  })
  let payloadB
  try {
    payloadB = await emitOneAndFlush(loadB)
  } finally {
    loadB.restore()
  }

  // Assert — each load got a distinct, non-empty id, and neither is the fixed
  // 'no-session' sentinel that today collapses every blocked-storage visitor into one.
  assert.ok(payloadA.sessionId, 'load A must carry a session id')
  assert.notEqual(payloadA.sessionId, 'no-session', 'fallback id must not be the fixed "no-session" constant')
  assert.notEqual(payloadB.sessionId, 'no-session', 'fallback id must not be the fixed "no-session" constant')
  assert.notEqual(
    payloadA.sessionId,
    payloadB.sessionId,
    'two separate loads with blocked storage must get DIFFERENT ids, not a shared constant'
  )
})

test('getSessionId returns a stable per-tab id across flushes when sessionStorage works', async () => {
  // Arrange — a working sessionStorage; the id is persisted and reused within a load.
  const env = installBrowserEnv({ randomUUID: () => 'stable-tab-id' })
  try {
    const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust()}`)

    // Act — two separate flushes within the same load.
    recordEvent('a', {})
    flushEvents()
    recordEvent('b', {})
    flushEvents()

    // Assert — both beacons carry the same stable id.
    assert.equal(env.beaconCalls.length, 2, 'expected two beacons')
    const first = await readBeaconPayload(env.beaconCalls[0])
    const second = await readBeaconPayload(env.beaconCalls[1])
    assert.equal(first.sessionId, second.sessionId, 'a working sessionStorage yields one stable per-tab id')
  } finally {
    env.restore()
  }
})

test('recordEvent stamps a numeric ts on each buffered interaction', async () => {
  const env = installBrowserEnv()
  try {
    const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust()}`)

    const before = Date.now()
    recordEvent('project_interaction', { project_id: 'gvp' })
    const after = Date.now()
    flushEvents()

    const payload = await readBeaconPayload(env.beaconCalls[0])
    const ev = payload.events[0]
    assert.equal(typeof ev.ts, 'number', 'recorded event must carry a numeric ts')
    assert.ok(ev.ts >= before && ev.ts <= after, 'ts must be stamped at record time')
  } finally {
    env.restore()
  }
})

test('recordEvent no-ops on an empty or missing event name', async () => {
  const env = installBrowserEnv()
  try {
    const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust()}`)

    recordEvent('', { project_id: 'gvp' })
    recordEvent(undefined, { project_id: 'gvp' })
    flushEvents()

    assert.equal(env.beaconCalls.length, 0, 'an empty/missing name must not buffer anything to flush')
  } finally {
    env.restore()
  }
})

test('the buffer auto-flushes at the server batch cap (<=25), not above it', async () => {
  // The server caps a single beacon batch at MAX_EVENTS_PER_BATCH=25
  // (aws/src/common/events-shared.js, ADR-0009 SEC-3). If the FE buffers MORE than
  // that before flushing, the overflow events are silently dropped server-side. So
  // the FE auto-flush threshold must be <=25: 25 buffered events trigger a flush,
  // 24 do not yet.
  const SERVER_BATCH_CAP = 25
  const env = installBrowserEnv()
  try {
    const { recordEvent } = await import(`../js/site-events.js${bust()}`)

    // One short of the cap: still buffering, no auto-flush yet.
    for (let i = 0; i < SERVER_BATCH_CAP - 1; i++) recordEvent('tick', { i })
    assert.equal(env.beaconCalls.length, 0, '24 events must not auto-flush yet')

    // The 25th event reaches the cap and forces a flush carrying the full buffer.
    recordEvent('tick', { i: SERVER_BATCH_CAP - 1 })
    assert.equal(env.beaconCalls.length, 1, 'reaching the server batch cap (25) must auto-flush')
    const payload = await readBeaconPayload(env.beaconCalls[0])
    assert.equal(
      payload.events.length,
      SERVER_BATCH_CAP,
      'the capped flush must carry no more than the server cap so no event is dropped'
    )
  } finally {
    env.restore()
  }
})

test('flushEvents is a no-op when the buffer is empty', async () => {
  const env = installBrowserEnv()
  try {
    const { flushEvents } = await import(`../js/site-events.js${bust()}`)

    flushEvents()

    assert.equal(env.beaconCalls.length, 0, 'an empty buffer must not produce a beacon')
    assert.equal(env.fetchCalls.length, 0, 'an empty buffer must not produce a keepalive fetch')
  } finally {
    env.restore()
  }
})

test('the beacon posts a CORS-safelisted text/plain blob', async () => {
  const env = installBrowserEnv()
  try {
    const { recordEvent, flushEvents } = await import(`../js/site-events.js${bust()}`)

    recordEvent('project_interaction', { project_id: 'gvp' })
    flushEvents()

    const { blob } = env.beaconCalls[0]
    assert.ok(blob.type.startsWith('text/plain'), 'beacon blob must be text/plain (CORS-safelisted, no preflight)')
  } finally {
    env.restore()
  }
})
