/**
 * A Chrome DevTools Protocol client in ~150 lines, with no dependencies.
 *
 * WHY THIS EXISTS RATHER THAN PLAYWRIGHT. ADR-0015 §11.6 deferred the journey harness
 * because "standing up headless Chromium is its own project with its own flake budget", and
 * this repo declares neither `dependencies` nor `devDependencies` — a deliberate property
 * that `node --test` and every test in `test/` rely on. Adding a browser automation library
 * for one harness would be the largest dependency decision the project has ever made, taken
 * to close the cheapest remaining gap.
 *
 * It turns out not to be needed. Node 22 has a global `WebSocket`, and CDP is a JSON
 * protocol over one socket: launch Chrome with `--remote-debugging-port`, read the target
 * list over HTTP, connect, and send `{id, method, params}`. That is the whole client.
 *
 * WHAT THIS BUYS over the stub-DOM harness in test/fixtures/chat-harness.mjs, which is
 * where every other M2 claim is pinned: REAL layout and REAL hit-testing. A stub cannot tell
 * you whether a click at a coordinate reaches the site or is swallowed by a fixed overlay,
 * because it has no compositor — and that hit-test is the single assertion ADR-0015 §4.4
 * calls the highest-value one in the app half. Everything a stub CAN answer stays in
 * `node --test`, where it is fast and deterministic.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

export function findChrome () {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) || null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the debugger's HTTP endpoint until Chrome is listening. */
async function debuggerUrl (port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      const body = await res.json()
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
    } catch (err) {
      lastErr = err
    }
    await sleep(120)
  }
  throw new Error(`Chrome never opened its debugger on ${port}: ${lastErr}`)
}

/**
 * Launch headless Chrome and attach to a page.
 * @param {{width?: number, height?: number, reducedMotion?: boolean}} [opts]
 */
export async function launch (opts = {}) {
  const bin = findChrome()
  if (!bin) {
    throw new Error(
      'No Chrome or Chromium found. Looked in:\n  ' + CHROME_CANDIDATES.join('\n  ')
    )
  }
  const width = opts.width || 1280
  const height = opts.height || 900
  // A port that is almost certainly free, and a throwaway profile so the run cannot touch
  // the operator's own Chrome state — no history, no cookies, no sign-ins.
  const port = 9400 + Math.floor(Math.random() * 500)
  const profile = mkdtempSync(join(tmpdir(), 'gvp-journey-'))

  const chrome = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    `--window-size=${width},${height}`,
    ...(opts.reducedMotion ? ['--force-prefers-reduced-motion'] : []),
    // Opt-in extras, e.g. the fake-microphone flags scripts/qa/voice-stage-probe.mjs needs.
    ...(Array.isArray(opts.chromeArgs) ? opts.chromeArgs : []),
    'about:blank'
  ], { stdio: 'ignore' })

  const browserWs = await debuggerUrl(port)
  const browser = await connect(browserWs)

  // One fresh tab, attached in flat mode so its messages arrive on this same socket.
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })

  const page = {
    send: (method, params) => browser.send(method, params, sessionId),
    async close () {
      try { await browser.send('Browser.close') } catch (_) { /* already gone */ }
      browser.socket.close()
      chrome.kill()
      // Chrome writes to the profile on the way out; give it a moment so the rmSync below
      // does not race it into an ENOTEMPTY that fails an otherwise green run.
      await sleep(200)
      rmSync(profile, { recursive: true, force: true })
    }
  }

  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 768
  })
  return page
}

function connect (url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1

    socket.onerror = (e) => reject(new Error(`CDP socket error: ${e.message || e.type}`))
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const waiter = pending.get(msg.id)
      if (!waiter) return // an event, not a reply — this client does not subscribe
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`))
      else waiter.resolve(msg.result)
    }
    socket.onopen = () => resolve({
      socket,
      send (method, params = {}, sessionId) {
        const id = nextId++
        const frame = { id, method, params }
        if (sessionId) frame.sessionId = sessionId
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej, method })
          socket.send(JSON.stringify(frame))
          // A hung CDP call would otherwise hang the whole run with no clue which call it
          // was; the method name is the thing you need and the thing a bare timeout loses.
          setTimeout(() => {
            if (!pending.has(id)) return
            pending.delete(id)
            rej(new Error(`${method} timed out after 20s`))
          }, 20000)
        })
      }
    })
  })
}

/** Evaluate in the page and return the value. Throws with the page's own error text. */
export async function evaluate (page, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description || exceptionDetails.text
    throw new Error(`page threw: ${text}`)
  }
  return result.value
}

let gotoSeq = 0

export async function goto (page, url) {
  // A UNIQUE QUERY PARAM, because otherwise this is not always a navigation. Chrome treats
  // a URL differing only in its fragment as a SAME-DOCUMENT navigation: going from
  // `/#portfolio` to `/` does not reload, so the previous journey's module state, chat
  // stage and listeners all survive into the next one. That made this harness fail
  // intermittently on whichever journey happened to run second — a flake with a cause, not
  // a timing problem to paper over with a longer sleep.
  const u = new URL(url)
  u.searchParams.set('__journey', String(++gotoSeq))
  await page.send('Page.navigate', { url: u.toString() })
  // WAIT FOR THE APP TO BE WIRED, not merely for the document to exist. `readyState ===
  // 'complete'` plus a present #chatDialog was not enough: initChat() runs from app.js's
  // DOMContentLoaded handler, and until it does, the EV_OPEN_CHAT listener does not exist —
  // so a journey that opened the chat too early dispatched into nothing and failed on
  // whichever claim happened to go first.
  //
  // `data-chat-stage` is the honest signal: js/chat.js sets it to 'closed' at the END of
  // init (the row in test/chat-stage-wiring.test.mjs that pins "the DOM agrees with the
  // stage from boot" is what makes this reliable). Waiting on a real readiness marker
  // instead of a longer sleep is the difference between a harness people run and one they
  // learn to ignore.
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const ready = await evaluate(page, () => (
      document.readyState === 'complete'
      && Boolean(document.getElementById('chatDialog')?.dataset.chatStage)
    )).catch(() => false)
    if (ready) return
    await sleep(80)
  }
  throw new Error(`page never became ready: ${url}`)
}

/** A REAL click at viewport coordinates — the thing a stub DOM cannot do. */
export async function clickAt (page, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

export async function pressKey (page, key) {
  const codes = { Escape: 27, Enter: 13, Tab: 9 }
  const common = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key] }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

export { sleep }
