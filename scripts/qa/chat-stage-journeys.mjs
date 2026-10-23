#!/usr/bin/env node
/**
 * The M2 journey harness (ADR-0015 §11.6) — real browser, real layout, real hit-testing.
 *
 *     node scripts/qa/chat-stage-journeys.mjs            # starts its own static server
 *     node scripts/qa/chat-stage-journeys.mjs http://localhost:8766
 *
 * Exit 0 when every journey passes, 1 otherwise. NOT part of `node --test`: it launches
 * Chrome, so it is opt-in and run by hand or in a job that has a browser.
 *
 * WHAT BELONGS HERE, AND WHAT DELIBERATELY DOES NOT. ADR-0015 §11.6 says to move this to
 * the end of M2 and let no acceptance bullet depend on it alone — so every claim that a
 * stub DOM can settle is pinned in `node --test` (test/chat-stage*.test.mjs,
 * test/site-state*.test.mjs) where it is fast and deterministic. What is left is the set of
 * claims that need a compositor:
 *
 *   1. THE HIT-TEST. §4.4 calls it the highest-value assertion in the app half, and it is
 *      the one thing no unit test in this repo can make: does a click at a coordinate over
 *      the site actually reach the site while the assistant is yielded? A stub has no
 *      layout, so it cannot tell a hidden backdrop from a transparent one that still eats
 *      every click. The unit suite asserts `backdropHidden: true` as DATA; this asserts the
 *      consequence.
 *   2. REAL CSS. The stage styling is a CSS file the unit tests read as text. Here the
 *      browser resolves the cascade, the media queries and the `pointer-events` that
 *      js/chat.js sets inline — including the ≤640px full-screen rule that once turned the
 *      minimised pill into a viewport-tall lozenge.
 *   3. REAL KEYS AND REAL EVENT ORDER. Escape reaches both the chat and the dialog in front
 *      of it, in the order the browser chooses, through listeners neither test wrote.
 *
 * Each journey returns a list of {claim, ok, detail} rather than throwing on the first
 * failure, so one broken journey does not hide the state of the others.
 */

import { spawn } from 'node:child_process'
import { launch, goto, evaluate, clickAt, pressKey, sleep, findChrome } from './cdp.mjs'

const PORT = 8771
const ORIGIN = process.argv[2] || `http://127.0.0.1:${PORT}`
const OWN_SERVER = !process.argv[2]

// ---------------------------------------------------------------- page helpers

const stage = (page) => evaluate(page, () => (
  document.getElementById('chatDialog').dataset.chatStage || null
))

const openChat = async (page) => {
  await evaluate(page, () => { window.dispatchEvent(new CustomEvent('gvp:open-chat')) })
  await sleep(500)
}

/** What is actually on top at this point — the question a stub cannot answer. */
const topAt = (page, x, y) => evaluate(page, (px, py) => {
  const el = document.elementFromPoint(px, py)
  if (!el) return 'nothing'
  if (el.closest('#chatDialog')) return 'chat'
  if (el.closest('#contactDialog')) return 'contact-dialog'
  if (el.closest('#projectDialog')) return 'project-dialog'
  if (el.closest('.project')) return 'project-card'
  if (el.closest('nav') || el.closest('header')) return 'site-chrome'
  return 'site'
}, x, y)

const box = (page, selector) => evaluate(page, (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
}, selector)

// ---------------------------------------------------------------- journeys

async function journeyYieldsTheStage (page) {
  const out = []
  await goto(page, `${ORIGIN}/`)
  await openChat(page)

  out.push({
    claim: 'opening the chat gives it the stage',
    ok: await stage(page) === 'modal'
  })

  // While modal it OWNS the viewport: a click over the page must not reach the page.
  const centre = await evaluate(page, () => ({ x: innerWidth / 2, y: innerHeight * 0.85 }))
  out.push({
    claim: 'a modal chat intercepts clicks on the site (the backdrop is doing its job)',
    ok: (await topAt(page, centre.x, centre.y)) === 'chat',
    detail: await topAt(page, centre.x, centre.y)
  })

  await evaluate(page, () => { document.getElementById('portfolioNav').click() })
  await sleep(600)
  out.push({ claim: 'navigating yields the stage to the site', ok: await stage(page) === 'docked' })

  // THE HIT-TEST. §4.4's highest-value assertion, and the reason this file exists.
  const card = await box(page, '#portfolioProjects .project')
  const panel = await box(page, '#chatDialog .chat-dialog__panel')
  out.push({
    claim: 'a click over a project card reaches the CARD while the chat is docked',
    ok: card && (await topAt(page, card.cx, card.y + 20)) === 'project-card',
    detail: card ? await topAt(page, card.cx, card.y + 20) : 'no project card found'
  })
  out.push({
    claim: 'and a click over the docked panel still reaches the PANEL',
    ok: panel && (await topAt(page, panel.cx, panel.y + 20)) === 'chat',
    detail: panel ? await topAt(page, panel.cx, panel.y + 20) : 'no panel found'
  })

  const chrome = await evaluate(page, () => {
    const d = document.getElementById('chatDialog')
    const p = d.querySelector('.chat-dialog__panel')
    const b = d.querySelector('.chat-dialog__backdrop')
    return {
      backdropHidden: b.hidden,
      scrollLock: document.body.classList.contains('chat-dialog-open'),
      ariaModal: p.getAttribute('aria-modal'),
      bodyOverflow: getComputedStyle(document.body).overflow
    }
  })
  out.push({
    claim: 'yielded: backdrop hidden, no scroll lock, aria-modal=false',
    ok: chrome.backdropHidden && !chrome.scrollLock && chrome.ariaModal === 'false'
      && chrome.bodyOverflow !== 'hidden',
    detail: JSON.stringify(chrome)
  })
  return out
}

async function journeyRealScrollWorks (page) {
  // The scroll-lock clause as a CONSEQUENCE rather than a class name: with the chat docked,
  // the visitor must be able to scroll the page. `body { overflow: hidden }` is one CSS
  // line and the unit suite can only see the class that applies it.
  const out = []
  await goto(page, `${ORIGIN}/#portfolio`)
  await openChat(page)
  await evaluate(page, () => { document.getElementById('portfolioNav').click() })
  await sleep(600)

  const scrolled = await evaluate(page, async () => {
    const before = window.scrollY
    window.scrollTo(0, 400)
    await new Promise((r) => setTimeout(r, 200))
    return { before, after: window.scrollY }
  })
  out.push({
    claim: 'the page still scrolls while the assistant is docked',
    ok: scrolled.after > scrolled.before,
    detail: JSON.stringify(scrolled)
  })
  return out
}

async function journeyEscapeDoesNotKillTheCall (page) {
  // The defect the critic pass found, end to end and through real listeners: a visitor on a
  // live call opens a project dialog and presses Escape to dismiss IT. Both the dialog's
  // handler and the chat's fire, in whatever order the browser chooses.
  const out = []
  await goto(page, `${ORIGIN}/#portfolio`)
  await openChat(page)

  // Pretend a call is up: the store is the seam the stage reducer reads, and minting a real
  // Gemini session in a QA run is neither possible nor desirable.
  await evaluate(page, async () => {
    const m = await import('/js/site-state.js')
    m.setVoiceActive(true, { origin: 'system' })
  })

  await evaluate(page, () => {
    const card = document.querySelector('#portfolioProjects .project')
    card.click()
  })
  await sleep(600)
  const yielded = await stage(page)
  out.push({
    claim: 'opening a project card yields the stage',
    ok: yielded === 'docked' || yielded === 'minimized',
    detail: yielded
  })

  await pressKey(page, 'Escape')
  await sleep(500)
  const after = await evaluate(page, async () => {
    const m = await import('/js/site-state.js')
    return {
      stage: document.getElementById('chatDialog').dataset.chatStage,
      voiceActive: m.getSiteState().voiceActive,
      projectDialogHidden: document.getElementById('projectDialog').hidden
    }
  })
  out.push({
    claim: 'Escape dismisses the project dialog',
    ok: after.projectDialogHidden,
    detail: JSON.stringify(after)
  })
  out.push({
    claim: 'Escape aimed at the dialog does NOT close the chat (invariant #20)',
    ok: after.stage !== 'closed',
    detail: `stage=${after.stage}`
  })
  return out
}

async function journeyPillIsUsableOnNarrow (page) {
  // The ≤640px full-screen rule once made the minimised pill a viewport-tall lozenge. That
  // was caught by eye; this catches it by measurement.
  const out = []
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true
  })
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await evaluate(page, () => { window.location.hash = '#labs' })
  await sleep(700)

  out.push({ claim: 'narrow + navigate minimises', ok: await stage(page) === 'minimized' })

  const pill = await box(page, '#chatDialog .chat-dialog__panel')
  out.push({
    claim: 'the pill is a pill, not a full-height lozenge',
    ok: pill && pill.h < 140 && pill.w < 320,
    detail: pill ? `${Math.round(pill.w)}x${Math.round(pill.h)}` : 'no panel'
  })
  out.push({
    claim: 'the pill is inside the viewport',
    ok: pill && pill.y >= 0 && pill.y + pill.h <= 844 + 1 && pill.x >= 0,
    detail: pill ? `at ${Math.round(pill.x)},${Math.round(pill.y)}` : 'no panel'
  })

  // Tapping it restores — a real click at real coordinates.
  if (pill) {
    await clickAt(page, pill.cx, pill.cy)
    await sleep(600)
  }
  out.push({
    claim: 'tapping the pill brings the conversation back',
    ok: await stage(page) === 'modal',
    detail: await stage(page)
  })

  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  })
  return out
}

async function journeyContactFormIsReachable (page) {
  // The layering fix, as a consequence: with the chat minimised and the form open, a click
  // where the two could overlap must reach the FORM.
  const out = []
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await evaluate(page, () => { document.getElementById('footerOpenContactBtn').click() })
  await sleep(700)

  out.push({ claim: 'the contact form minimises the chat', ok: await stage(page) === 'minimized' })

  const pill = await box(page, '#chatDialog .chat-dialog__panel')
  out.push({
    claim: 'the pill does not sit on top of the contact form',
    ok: pill && (await topAt(page, pill.cx, pill.cy)) !== 'chat'
      || (await evaluate(page, () => {
        const c = document.getElementById('contactDialog').querySelector('.contact-dialog__panel')
        const p = document.getElementById('chatDialog').querySelector('.chat-dialog__panel')
        const a = c.getBoundingClientRect(); const b = p.getBoundingClientRect()
        return a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom
      })),
    detail: pill ? await topAt(page, pill.cx, pill.cy) : 'no pill'
  })

  const field = await box(page, '#contactForm input[name="name"]')
  out.push({
    claim: 'the contact form is clickable',
    ok: field && (await topAt(page, field.cx, field.cy)) === 'contact-dialog',
    detail: field ? await topAt(page, field.cx, field.cy) : 'no name field'
  })
  return out
}

// ---------------------------------------------------------------- runner

const JOURNEYS = [
  ['the assistant yields the stage', journeyYieldsTheStage],
  ['the page still scrolls', journeyRealScrollWorks],
  ['Escape does not end the call', journeyEscapeDoesNotKillTheCall],
  ['the pill is usable on narrow', journeyPillIsUsableOnNarrow],
  ['the contact form stays reachable', journeyContactFormIsReachable]
]

async function main () {
  if (!findChrome()) {
    console.error('No Chrome or Chromium found — this harness needs one. Skipping is not a pass.')
    process.exit(2)
  }

  let server = null
  if (OWN_SERVER) {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
      cwd: new URL('../..', import.meta.url).pathname, stdio: 'ignore'
    })
    await sleep(900)
  }

  const page = await launch({ width: 1280, height: 900 })
  const results = []
  try {
    for (const [name, journey] of JOURNEYS) {
      try {
        for (const r of await journey(page)) results.push({ journey: name, ...r })
      } catch (err) {
        results.push({ journey: name, claim: 'journey ran to completion', ok: false, detail: String(err && err.message) })
      }
    }
  } finally {
    await page.close()
    if (server) server.kill()
  }

  let failed = 0
  let current = null
  for (const r of results) {
    if (r.journey !== current) { current = r.journey; console.log(`\n${current}`) }
    if (!r.ok) failed++
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.claim}${r.ok || !r.detail ? '' : `\n       ${r.detail}`}`)
  }
  console.log(`\n${results.length - failed}/${results.length} claims held`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
