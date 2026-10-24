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

  // ADR-0027: on a wide viewport opening lands the DOCKED main window (it was `modal`). The
  // modal-intercepts-clicks claim moved to the narrow journey, the one place modal is now the
  // open state.
  out.push({
    claim: 'opening the chat on a wide viewport docks the main window (ADR-0027)',
    ok: await stage(page) === 'docked'
  })

  await evaluate(page, () => { document.getElementById('portfolioNav').click() })
  await sleep(600)
  out.push({ claim: 'navigating leaves it docked (idempotent yield)', ok: await stage(page) === 'docked' })

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

  // Narrow is where `modal` is still the open state (ADR-0027 N-W2), and while modal it OWNS
  // the viewport: a click over the page must not reach the page.
  out.push({ claim: 'narrow: opening the chat is the modal', ok: await stage(page) === 'modal' })
  const centre = await evaluate(page, () => ({ x: innerWidth / 2, y: innerHeight * 0.85 }))
  out.push({
    claim: 'a modal chat intercepts clicks on the site (the backdrop is doing its job)',
    ok: (await topAt(page, centre.x, centre.y)) === 'chat',
    detail: await topAt(page, centre.x, centre.y)
  })

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

// ---------------------------------------------------------------- ADR-0027: wide + compact
//
// The W-bullets of .claude/state/design-notes.md ("2026-10-24 — wide docked assistant
// window") that need a compositor: measured widths and anchors, real hit-tests around the
// card, horizontal overflow, real key activation, and what the transition does per frame.
// The numbers are dockedCardWidth's, imported from the same module the page runs, so a
// journey never restates a formula.

const DOCK_INSET = 20 // the docked shell's padding, clamp(0.75rem, 2vw, 1.25rem), at >= 1000px

const setViewport = async (page, width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 768
  })
}

const expectedWidth = (page, size) => evaluate(page, async (sz) => {
  const m = await import('/js/chat-stage.js')
  return m.dockedCardWidth({ viewportWidth: innerWidth, size: sz })
}, size)

const card = (page) => evaluate(page, () => {
  const d = document.getElementById('chatDialog')
  const r = d.querySelector('.chat-dialog__panel').getBoundingClientRect()
  const t = d.querySelector('[data-chat-size-toggle]')
  const tr = t.getBoundingClientRect()
  return {
    stage: d.dataset.chatStage,
    size: d.dataset.chatSize,
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height,
    vw: innerWidth, vh: innerHeight,
    toggleShown: getComputedStyle(t).display !== 'none' && tr.width > 0,
    toggle: { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2 },
    pressed: t.getAttribute('aria-pressed'),
    label: t.getAttribute('aria-label')
  }
})

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol
const fmt = (c) => `${c.stage}/${c.size} w=${c.w.toFixed(1)} right=${c.right.toFixed(1)} bottom=${c.bottom.toFixed(1)} vw=${c.vw}`

// Enter / Space with the text the browser needs to ACTIVATE a button (pressKey sends none).
const activateKey = async (page, key) => {
  const spec = key === 'Enter'
    ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }
    : { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec })
}

const clearSizePref = (page) => evaluate(page, () => { localStorage.removeItem('gvp-chat-size') })

async function journeyFirstOpenIsWide (page) {
  // W1: the first open, with no stored preference, is the docked card at WIDE size, anchored
  // in the compact card's corner. Checked at the PO's two desktop sizes and through two
  // different openers (the launcher event and a real click on the hero voice button).
  const out = []
  for (const [w, h] of [[1440, 900], [1024, 768]]) {
    await setViewport(page, w, h)
    await goto(page, `${ORIGIN}/`)
    await clearSizePref(page)
    await goto(page, `${ORIGIN}/`)
    await openChat(page)
    await sleep(300) // let the 200ms size transition settle
    const c = await card(page)
    const want = await expectedWidth(page, 'wide')
    out.push({
      claim: `${w}x${h}: text open lands docked + wide at dockedCardWidth (${want}px)`,
      ok: c.stage === 'docked' && c.size === 'wide' && near(c.w, want),
      detail: fmt(c)
    })
    out.push({
      claim: `${w}x${h}: anchored bottom-right at the ${DOCK_INSET}px gutter`,
      ok: near(c.right, w - DOCK_INSET) && near(c.bottom, h - DOCK_INSET),
      detail: fmt(c)
    })
    out.push({
      claim: `${w}x${h}: the toggle is visible from the first frame, pressed, named "Wide chat window"`,
      ok: c.toggleShown && c.pressed === 'true' && c.label === 'Wide chat window',
      detail: JSON.stringify({ shown: c.toggleShown, pressed: c.pressed, label: c.label })
    })

    // The hero voice CTA, by a real click (it opens the chat awaiting a voice start - no mic
    // or network needed). The OPEN is what is under test: the same window, not a modal.
    await goto(page, `${ORIGIN}/`)
    const mic = await box(page, '#heroVoiceMic')
    if (mic && mic.w > 0) await clickAt(page, mic.cx, mic.cy)
    else await evaluate(page, () => document.getElementById('heroVoiceMic')?.click())
    await sleep(700)
    const v = await card(page)
    out.push({
      claim: `${w}x${h}: the voice CTA opens the same docked wide window`,
      ok: Boolean(mic) && v.stage === 'docked' && v.size === 'wide' && near(v.w, want),
      detail: mic ? fmt(v) : 'no #heroVoiceMic'
    })
  }
  await setViewport(page, 1280, 900)
  return out
}

async function journeyToggleRightAfterOpen (page) {
  // W2: the toggle works at the very first open, before any message, by mouse AND by keys,
  // keeps focus on itself, and only the left edge moves.
  const out = []
  await setViewport(page, 1440, 900)
  await goto(page, `${ORIGIN}/`)
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await sleep(300)
  const wide = await card(page)
  const compactW = await expectedWidth(page, 'compact')

  await clickAt(page, wide.toggle.x, wide.toggle.y)
  await sleep(300)
  const compact = await card(page)
  const focusOnToggle = () => evaluate(page, () => document.activeElement?.matches('[data-chat-size-toggle]') || false)
  out.push({
    claim: 'a click right after the first open switches to compact (384px)',
    ok: compact.size === 'compact' && near(compact.w, compactW) && compact.pressed === 'false',
    detail: fmt(compact)
  })
  out.push({
    claim: 'the anchor corner does not move (right and bottom edges identical)',
    ok: near(compact.right, wide.right) && near(compact.bottom, wide.bottom),
    detail: `wide ${fmt(wide)} | compact ${fmt(compact)}`
  })
  out.push({ claim: 'focus stays on the toggle after a click', ok: await focusOnToggle() })
  out.push({ claim: 'the accessible name never changes', ok: compact.label === wide.label })

  await activateKey(page, 'Enter')
  await sleep(300)
  const byEnter = await card(page)
  out.push({
    claim: 'Enter on the focused toggle switches back to wide',
    ok: byEnter.size === 'wide' && near(byEnter.w, wide.w),
    detail: fmt(byEnter)
  })
  await activateKey(page, ' ')
  await sleep(300)
  const bySpace = await card(page)
  out.push({
    claim: 'Space switches it again, and focus is still on the toggle',
    ok: bySpace.size === 'compact' && await focusOnToggle(),
    detail: fmt(bySpace)
  })
  out.push({
    claim: 'the stage never moved during the toggling',
    ok: [compact, byEnter, bySpace].every((c) => c.stage === 'docked')
  })
  return out
}

async function journeyPageUsableAroundTheCard (page) {
  // W4 / O2 / invariant #22 at the DEFAULT window: no backdrop, no lock, real hit-tests at
  // both sizes, a nav click outside the card navigates.
  const out = []
  await setViewport(page, 1440, 900)
  await goto(page, `${ORIGIN}/`)
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await sleep(300)
  for (const size of ['wide', 'compact']) {
    const c = await card(page)
    if (c.size !== size) {
      await clickAt(page, c.toggle.x, c.toggle.y)
      await sleep(300)
    }
    const now = await card(page)
    const outside = await topAt(page, 100, Math.round(now.vh * 0.6))
    const inside = await topAt(page, now.left + now.w / 2, now.top + now.h / 2)
    out.push({
      claim: `${size}: elementFromPoint at x=100 reaches the site, over the card reaches the card`,
      ok: outside !== 'chat' && outside !== 'nothing' && inside === 'chat',
      detail: `outside=${outside} inside=${inside} ${fmt(now)}`
    })
    const chrome = await evaluate(page, () => ({
      backdropHidden: document.querySelector('#chatDialog .chat-dialog__backdrop').hidden,
      ariaModal: document.querySelector('#chatDialog .chat-dialog__panel').getAttribute('aria-modal'),
      overflow: getComputedStyle(document.body).overflow
    }))
    out.push({
      claim: `${size}: no backdrop, aria-modal=false, no scroll lock`,
      ok: chrome.backdropHidden && chrome.ariaModal === 'false' && chrome.overflow !== 'hidden',
      detail: JSON.stringify(chrome)
    })
  }
  const nav = await box(page, '#portfolioNav')
  if (nav) await clickAt(page, nav.cx, nav.cy)
  await sleep(700)
  out.push({
    claim: 'a real click on a nav link outside the card navigates, card stays docked',
    ok: Boolean(nav) && (await evaluate(page, () => location.hash)) === '#portfolio' && await stage(page) === 'docked',
    detail: await evaluate(page, () => location.hash)
  })
  return out
}

async function journeyNoHorizontalOverflow (page) {
  // W4: at every width the PO listed, open in the default state and (where it exists) after
  // a toggle: no horizontal scroll, and the card inside the viewport.
  const out = []
  const sizes = [[320, 800], [375, 812], [640, 900], [767, 900], [768, 1024], [1024, 768],
    [1280, 900], [1440, 900], [1920, 1080], [1280, 600]]
  for (const [w, h] of sizes) {
    await setViewport(page, w, h)
    await goto(page, `${ORIGIN}/`)
    await clearSizePref(page)
    await goto(page, `${ORIGIN}/`)
    await openChat(page)
    await sleep(300)
    const check = async (label) => {
      const m = await evaluate(page, () => ({
        sw: document.scrollingElement.scrollWidth, cw: document.scrollingElement.clientWidth
      }))
      const c = await card(page)
      const inside = c.left >= -0.5 && c.right <= c.vw + 0.5 && c.top >= -0.5 && c.bottom <= c.vh + 0.5
      out.push({
        claim: `${w}x${h} ${label}: no horizontal scroll, card inside the viewport`,
        ok: m.sw <= m.cw && inside,
        detail: `scrollWidth=${m.sw} clientWidth=${m.cw} ${fmt(c)} top=${c.top.toFixed(1)}`
      })
      return c
    }
    const c = await check(`default (${(await card(page)).stage})`)
    if (c.toggleShown) {
      await clickAt(page, c.toggle.x, c.toggle.y)
      await sleep(300)
      await check('after toggle')
    }
  }
  await setViewport(page, 1280, 900)
  return out
}

async function journeyNarrowUnchanged (page) {
  // W5 / N-W2: at 375 an open is still the full-screen modal, with no toggle.
  const out = []
  await setViewport(page, 375, 812)
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  const c = await card(page)
  out.push({
    claim: '375x812: open is the full-screen modal with no size toggle',
    ok: c.stage === 'modal' && !c.toggleShown && c.w >= 374,
    detail: fmt(c)
  })
  await setViewport(page, 1280, 900)
  return out
}

async function journeyMinimizeRestoreKeepsSize (page) {
  // W3 / W6: minimise -> the resume chip -> back at the LAST size, both ways; Escape on the
  // docked card minimises (N-W3) and hands focus to the chip (ADR-0027 §5.2).
  const out = []
  await setViewport(page, 1440, 900)
  await goto(page, `${ORIGIN}/`)
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await sleep(300)

  const restoreViaChip = async () => {
    const chip = await box(page, '#agentActiveChip')
    if (chip && chip.w > 0) await clickAt(page, chip.cx, chip.cy)
    else await evaluate(page, () => document.getElementById('agentActiveChip').click())
    await sleep(400)
  }
  const minimise = async () => {
    await evaluate(page, () => document.querySelector('#chatDialog .chat-dialog__minimize').click())
    await sleep(300)
  }

  await minimise()
  out.push({ claim: 'minimise from wide -> pill', ok: await stage(page) === 'minimized' })
  await restoreViaChip()
  let c = await card(page)
  out.push({ claim: 'restore lands docked at WIDE', ok: c.stage === 'docked' && c.size === 'wide', detail: fmt(c) })

  await clickAt(page, c.toggle.x, c.toggle.y)
  await sleep(300)
  await minimise()
  await restoreViaChip()
  c = await card(page)
  out.push({ claim: 'toggle compact -> minimise -> restore lands COMPACT', ok: c.stage === 'docked' && c.size === 'compact', detail: fmt(c) })

  await evaluate(page, () => document.getElementById('chatComposerInput')?.focus())
  await pressKey(page, 'Escape')
  await sleep(300)
  const esc = await evaluate(page, () => ({
    stage: document.getElementById('chatDialog').dataset.chatStage,
    focus: document.activeElement?.id || document.activeElement?.tagName
  }))
  out.push({
    claim: 'Escape on the focused docked card minimises and focus lands on the resume chip',
    ok: esc.stage === 'minimized' && esc.focus === 'agentActiveChip',
    detail: JSON.stringify(esc)
  })

  await evaluate(page, () => { document.getElementById('footerOpenContactBtn').click() })
  await sleep(500)
  await evaluate(page, () => { document.querySelector('#contactDialog .contact-dialog__close, #contactDialog [data-close]')?.click() })
  await sleep(500)
  c = await card(page)
  out.push({
    claim: 'contact form open -> close returns the card at the last size (compact)',
    ok: c.stage === 'docked' && c.size === 'compact',
    detail: fmt(c)
  })

  // N-W1: the choice survives a reload.
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await sleep(300)
  c = await card(page)
  out.push({ claim: 'reload -> open lands compact (localStorage)', ok: c.size === 'compact', detail: fmt(c) })
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/`)
  await openChat(page)
  await sleep(300)
  c = await card(page)
  out.push({ claim: 'cleared storage -> open lands wide', ok: c.size === 'wide', detail: fmt(c) })
  return out
}

async function journeyTransitionMotion (page) {
  // W7: with motion, the toggle animates for <= 250ms and the corner never moves; with
  // reduced motion it reaches the final width in the first frame.
  const out = []
  // READ THE TRANSITION, don't race it. A headless background tab throttles timers to ~1s
  // (measured: a 16ms setTimeout sampler got one frame at 895ms), so a wall-clock sampler
  // measures the throttle. The Web Animations API exposes the CSS transition the click
  // started: its duration, and - paused at a chosen currentTime - the exact mid-flight rect.
  const sample = () => evaluate(page, () => {
    const d = document.getElementById('chatDialog')
    const p = d.querySelector('.chat-dialog__panel')
    const before = p.getBoundingClientRect()
    d.querySelector('[data-chat-size-toggle]').click()
    const first = p.getBoundingClientRect()
    const anims = p.getAnimations().filter((a) => /width/.test(a.transitionProperty || ''))
    const longest = anims.reduce((m, a) => Math.max(m, Number(a.effect.getComputedTiming().endTime) || 0), 0)
    let mid = null
    if (anims.length) {
      for (const a of anims) { a.pause(); a.currentTime = 100 }
      const r = p.getBoundingClientRect()
      mid = { w: r.width, right: r.right, bottom: r.bottom }
      for (const a of anims) a.finish()
    }
    const end = p.getBoundingClientRect()
    return {
      before: { w: before.width, right: before.right, bottom: before.bottom },
      first: { w: first.width, right: first.right, bottom: first.bottom },
      mid,
      end: { w: end.width, right: end.right, bottom: end.bottom },
      transitions: anims.map((a) => a.transitionProperty),
      longest
    }
  })

  for (const reduce of [false, true]) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]
    })
    await setViewport(page, 1440, 900)
    await goto(page, `${ORIGIN}/`)
    await clearSizePref(page)
    await goto(page, `${ORIGIN}/`)
    await page.send('Page.bringToFront').catch(() => {})
    await openChat(page)
    // Wait for the OPEN's seed animation to hand the panel back to the stylesheet (inline
    // transform/transition cleared) - measured otherwise, the "before" rect is mid-open.
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const idle = await evaluate(page, () => {
        const p = document.querySelector('#chatDialog .chat-dialog__panel')
        return !p.style.transform && !p.style.transition && p.getAnimations().length === 0
      })
      if (idle) break
      await sleep(150)
    }
    const f = await sample()
    const corners = [f.before, f.first, f.mid, f.end].filter(Boolean)
    const rightFixed = corners.every((c) => near(c.right, f.before.right) && near(c.bottom, f.before.bottom))
    if (reduce) {
      out.push({
        claim: 'reduced motion: no size transition runs, the first frame is the final width',
        ok: f.transitions.length === 0 && near(f.first.w, f.end.w) && near(f.end.w, 384),
        detail: JSON.stringify(f)
      })
    } else {
      out.push({
        claim: 'with motion: width animates (mid-flight width is between) and lasts <= 250ms',
        ok: f.transitions.length > 0 && f.longest > 0 && f.longest <= 250 &&
          Boolean(f.mid) && f.mid.w < f.before.w - 1 && f.mid.w > f.end.w + 1,
        detail: JSON.stringify(f)
      })
    }
    out.push({ claim: `${reduce ? 'reduced' : 'motion'}: the anchor corner never moves`, ok: rightFixed, detail: JSON.stringify(corners) })
  }
  await page.send('Emulation.setEmulatedMedia', { features: [] })
  return out
}

async function journeyBesideProjectDialog (page) {
  // ADR-0027 §9's drift, now under ADR-0029: a card docked BESIDE a project dialog by a chip
  // reserves its column and is lifted above the scrim; the dialog moves left of it. Narrowing
  // below 1016 drops the reserve, and over any card/panel overlap the DIALOG wins.
  const out = []
  await setViewport(page, 1920, 1080)
  await goto(page, `${ORIGIN}/#portfolio`)
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/#portfolio`)
  await openProjectFromPage(page)
  // The chips sit at the foot of the panel, which scrolls - bring the chip into view first,
  // or the "real click" lands on the scrim below the fold.
  await evaluate(page, () => {
    document.querySelector('#projectDialog [data-project-chip="summarize"]')?.scrollIntoView({ block: 'center' })
  })
  await sleep(200)
  const chipBox = await box(page, '#projectDialog [data-project-chip="summarize"]')
  if (chipBox) await clickAt(page, chipBox.cx, chipBox.cy)
  await sleep(900)
  const c = await card(page)
  out.push({
    claim: '1920x1080 chip: docked WIDE beside the dialog (a wide column is reserved), toggle shown',
    ok: Boolean(chipBox) && c.stage === 'docked' && c.size === 'wide' && c.toggleShown,
    detail: chipBox ? fmt(c) : 'no project chip'
  })
  const hit = await topAt(page, c.left + c.w / 2, c.top + c.h / 2)
  out.push({
    claim: 'the beside card is ON TOP of the project dialog scrim (hit-test reaches the chat)',
    ok: hit === 'chat',
    detail: `elementFromPoint over the card -> ${hit}`
  })
  const dialogHit = await evaluate(page, () => {
    const r = document.querySelector('#projectDialog .project-dialog__panel').getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + 40)
    return Boolean(el && el.closest('#projectDialog'))
  })
  out.push({ claim: 'and the project dialog itself is still on top of its own area', ok: dialogHit })

  // Narrow below 1016 with the dialog still open: nothing is reserved any more and the card
  // overlaps the (re-centred) panel; over that overlap the DIALOG must win.
  await setViewport(page, 1000, 900)
  await evaluate(page, () => { window.dispatchEvent(new Event('resize')) })
  await sleep(500)
  const overlap = await evaluate(page, () => {
    const a = document.querySelector('#chatDialog .chat-dialog__panel').getBoundingClientRect()
    const b = document.querySelector('#projectDialog .project-dialog__panel').getBoundingClientRect()
    const l = Math.max(a.left, b.left); const r = Math.min(a.right, b.right)
    const t = Math.max(a.top, b.top); const btm = Math.min(a.bottom, b.bottom)
    const beside = document.getElementById('chatDialog').dataset.chatBeside
    const reserve = document.documentElement.style.getPropertyValue('--overlay-reserve-inline-end')
    if (r - l < 2 || btm - t < 2) return { none: true, beside, reserve }
    const el = document.elementFromPoint((l + r) / 2, (t + btm) / 2)
    return {
      width: r - l,
      top: el && el.closest('#projectDialog') ? 'project-dialog' : el && el.closest('#chatDialog') ? 'chat' : 'other',
      beside,
      reserve
    }
  })
  out.push({
    claim: '1920 -> 1000 with the dialog open: the reserve clears and over any overlap the PROJECT DIALOG wins',
    ok: overlap.beside === 'false' && overlap.reserve === '' && (overlap.none || overlap.top === 'project-dialog'),
    detail: JSON.stringify(overlap)
  })
  await setViewport(page, 1920, 1080)
  await evaluate(page, () => { window.dispatchEvent(new Event('resize')) })
  await sleep(500)
  out.push({
    claim: 'and widening back with the dialog still open reserves and lifts it again',
    ok: (await evaluate(page, () => document.getElementById('chatDialog').dataset.chatBeside)) === 'true'
  })

  await evaluate(page, () => document.querySelector('#projectDialog .project-dialog__close').focus())
  await pressKey(page, 'Escape')
  await sleep(600)
  const after = await card(page)
  out.push({
    claim: 'closing the dialog returns the card to the stored size (wide) and drops it back under dialogs',
    ok: after.stage === 'docked' && after.size === 'wide' &&
      (await evaluate(page, () => getComputedStyle(document.getElementById('chatDialog')).zIndex)) === '1085',
    detail: fmt(after)
  })
  await setViewport(page, 1280, 900)
  return out
}

// ---------------------------------------------------------------- ADR-0029 (the reserved column)

const openProjectFromPage = async (page) => {
  await evaluate(page, () => { document.querySelector('#portfolioProjects .project').click() })
  await sleep(700)
}

/** Everything ADR-0029 §7 asks a compositor about, in one read. */
const reserveState = (page) => evaluate(page, async () => {
  const m = await import('/js/chat-stage.js')
  const d = document.getElementById('chatDialog')
  const p = d.querySelector('.chat-dialog__panel')
  const pd = document.getElementById('projectDialog')
  const pp = pd.querySelector('.project-dialog__panel')
  const rect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height } }
  const tag = (el) => !el ? 'nothing'
    : el.closest('#chatDialog') ? 'chat'
      : el.closest('#projectDialog .project-dialog__panel') ? 'project-panel'
        : el.closest('#projectDialog') ? 'project-scrim' : 'page'
  const c = rect(p)
  const composer = document.getElementById('chatComposerInput').getBoundingClientRect()
  const panel = pd.hidden ? null : rect(pp)
  const layout = m.besideLayout({ viewportWidth: innerWidth, preferred: localStorage.getItem('gvp-chat-size') })
  return {
    vw: innerWidth,
    stage: d.dataset.chatStage,
    size: d.dataset.chatSize,
    beside: d.dataset.chatBeside,
    reserve: document.documentElement.style.getPropertyValue('--overlay-reserve-inline-end'),
    layout,
    projectOpen: !pd.hidden,
    card: c,
    panel,
    hitCard: tag(document.elementFromPoint(c.left + c.w / 2, c.top + c.h / 2)),
    hitComposer: tag(document.elementFromPoint(composer.left + composer.width / 2, composer.top + composer.height / 2)),
    hitPanel: panel ? tag(document.elementFromPoint(panel.left + panel.w / 2, panel.top + panel.h / 2)) : null,
    hitFarLeft: tag(document.elementFromPoint(6, innerHeight / 2)),
    hScroll: document.documentElement.scrollWidth > innerWidth,
    panelAriaModal: pp.getAttribute('aria-modal'),
    pageInert: ['body > header', 'body > main', 'body > footer'].map((s) => Boolean(document.querySelector(s)?.closest('[inert]')))
  }
})

const r1 = (n) => Math.round(n * 10) / 10

// The open's seed animation scales the panel from the launcher, and a headless background tab
// throttles its timers (see W7) - so a rect read too early is the launcher-sized card. Wait for
// the panel to be handed back to the stylesheet before measuring or clicking it.
const waitChatIdle = async (page) => {
  await page.send('Page.bringToFront').catch(() => {})
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const idle = await evaluate(page, () => {
      const p = document.querySelector('#chatDialog .chat-dialog__panel')
      return !p.style.transform && !p.style.transition && p.getAnimations().length === 0
    })
    if (idle) return
    await sleep(150)
  }
}

async function journeyReservedColumn (page) {
  // ADR-0029 §7, in a real browser: at 1280/1440/1920, for each stored size, in both opening
  // orders, the conversation stays usable beside an open project dialog.
  const out = []
  for (const [vw, vh] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    for (const pref of ['wide', 'compact']) {
      for (const order of ['chat-then-project', 'project-then-chat']) {
        const tag = `${vw} ${pref} ${order}`
        await setViewport(page, vw, vh)
        await goto(page, `${ORIGIN}/#portfolio`)
        await evaluate(page, (p) => localStorage.setItem('gvp-chat-size', p), pref)
        await goto(page, `${ORIGIN}/#portfolio`)
        await evaluate(page, async () => {
          const m = await import('/js/site-state.js')
          m.setVoiceActive(true, { origin: 'system' })
        })
        if (order === 'chat-then-project') {
          await openChat(page)
          await waitChatIdle(page)
          await openProjectFromPage(page)
        } else {
          await openProjectFromPage(page)
          await openChat(page)
        }
        await waitChatIdle(page)
        await sleep(300)
        const s = await reserveState(page)
        const gap = s.panel ? s.card.left - s.panel.right : null
        const panelOk = s.panel && s.panel.w >= 559.5 && s.panel.w <= s.layout.panelMax + 0.5
        out.push({
          claim: `${tag}: docked ${s.layout.size} and reserved; card, composer -> chat; panel -> panel; far left -> scrim`,
          ok: s.stage === 'docked' && s.size === s.layout.size && s.beside === 'true' &&
            s.reserve === `${s.layout.reserve}px` && s.hitCard === 'chat' && s.hitComposer === 'chat' &&
            s.hitPanel === 'project-panel' && s.hitFarLeft === 'project-scrim',
          detail: JSON.stringify({ stage: s.stage, size: s.size, beside: s.beside, reserve: s.reserve, hits: [s.hitCard, s.hitComposer, s.hitPanel, s.hitFarLeft] })
        })
        out.push({
          claim: `${tag}: no overlap (gap >= 20), panel width in [560, panelMax], no horizontal scroll`,
          ok: gap !== null && gap >= 20 && panelOk && !s.hScroll,
          detail: s.panel
            ? `card [${r1(s.card.left)}, ${r1(s.card.right)}] panel [${r1(s.panel.left)}, ${r1(s.panel.right)}] w=${r1(s.panel.w)} panelMax=${s.layout.panelMax} gap=${r1(gap)} hScroll=${s.hScroll}`
            : 'no project panel'
        })
        out.push({
          claim: `${tag}: a11y swap - panel aria-modal=false, header/main/footer inert`,
          ok: s.panelAriaModal === 'false' && s.pageInert.every(Boolean),
          detail: JSON.stringify({ ariaModal: s.panelAriaModal, inert: s.pageInert })
        })
        if (vw === 1440 && pref === 'wide' && order === 'chat-then-project') {
          out.push({
            claim: `1440 wide numbers: card [${r1(s.card.left)}, ${r1(s.card.right)}] (w ${r1(s.card.w)}), panel [${r1(s.panel.left)}, ${r1(s.panel.right)}] (w ${r1(s.panel.w)}), gap ${r1(gap)}`,
            ok: true
          })
        }

        // Only in one order per width/size: the interaction claims don't depend on order.
        if (order !== 'chat-then-project') continue

        // A click inside the chat (on its transcript area) never closes the dialog.
        await clickAt(page, s.card.left + s.card.w / 2, s.card.top + 60)
        await sleep(300)
        const afterChatClick = await evaluate(page, () => !document.getElementById('projectDialog').hidden)
        out.push({ claim: `${tag}: clicking inside the chat never closes the project dialog`, ok: afterChatClick })

        // Escape with focus in the composer: the chat's key, not the dialog's.
        await evaluate(page, () => document.getElementById('chatComposerInput').focus())
        await pressKey(page, 'Escape')
        await sleep(400)
        const esc = await evaluate(page, () => ({
          project: !document.getElementById('projectDialog').hidden,
          stage: document.getElementById('chatDialog').dataset.chatStage
        }))
        out.push({
          claim: `${tag}: Escape in the composer leaves the project dialog open (and minimises the chat)`,
          ok: esc.project && esc.stage === 'minimized',
          detail: JSON.stringify(esc)
        })
        // Restore: the chat comes back reserved beside the still-open dialog.
        await evaluate(page, () => document.getElementById('agentActiveChip')?.click())
        await sleep(400)
        const back = await evaluate(page, () => document.getElementById('chatDialog').dataset.chatBeside)
        out.push({
          claim: `${tag}: restoring over the open dialog reserves again (programmatic chip click - the chip itself is inert behind the scrim)`,
          ok: back === 'true',
          detail: back
        })

        // Tab only cycles between the project dialog and the chat.
        await evaluate(page, () => document.querySelector('#projectDialog .project-dialog__close').focus())
        const where = []
        for (let i = 0; i < 40; i++) {
          await pressKey(page, 'Tab')
          where.push(await evaluate(page, () => {
            const a = document.activeElement
            if (!a || a === document.body || a === document.documentElement) return 'body'
            if (a.closest('#projectDialog')) return 'project'
            if (a.closest('#chatDialog')) return 'chat'
            return `page:${a.id || a.tagName}`
          }))
        }
        const strays = where.filter((w) => w.startsWith('page:'))
        out.push({
          claim: `${tag}: Tab moves only between the project dialog and the chat`,
          ok: strays.length === 0 && where.includes('project') && where.includes('chat'),
          detail: JSON.stringify([...new Set(where)])
        })

        // The grey area LEFT of the dialog closes it; the chat and the call are untouched.
        await clickAt(page, 6, vh / 2)
        await sleep(500)
        const closed = await evaluate(page, async () => {
          const m = await import('/js/site-state.js')
          return {
            project: !document.getElementById('projectDialog').hidden,
            stage: document.getElementById('chatDialog').dataset.chatStage,
            reserve: document.documentElement.style.getPropertyValue('--overlay-reserve-inline-end'),
            inert: Boolean(document.querySelector('main')?.closest('[inert]')),
            voiceActive: m.getSiteState().voiceActive
          }
        })
        out.push({
          claim: `${tag}: a click on the grey area left of the dialog closes it; chat stays docked, reserve and inert cleared, voice untouched`,
          ok: !closed.project && closed.stage === 'docked' && closed.reserve === '' && !closed.inert && closed.voiceActive,
          detail: JSON.stringify(closed)
        })
      }
    }
  }
  await setViewport(page, 1280, 900)
  return out
}

async function journeyTuckBelow1016 (page) {
  // ADR-0029 §4 + N-P3: at 1000 px a page-opened project tucks the docked card into the pill
  // and closing it brings the card back; a chip there still opens the modal over the dialog.
  const out = []
  await setViewport(page, 1000, 768)
  await goto(page, `${ORIGIN}/#portfolio`)
  await clearSizePref(page)
  await goto(page, `${ORIGIN}/#portfolio`)
  await evaluate(page, async () => {
    const m = await import('/js/site-state.js')
    m.setVoiceActive(true, { origin: 'system' })
  })
  await openChat(page)
  await waitChatIdle(page)
  const before = await stage(page)
  await openProjectFromPage(page)
  const s = await reserveState(page)
  out.push({
    claim: '1000: a page-opened project tucks the docked card into the pill; nothing reserved, no h-scroll',
    ok: before === 'docked' && s.stage === 'minimized' && s.reserve === '' && s.beside === 'false' && !s.hScroll,
    detail: JSON.stringify({ before, stage: s.stage, reserve: s.reserve, hScroll: s.hScroll })
  })
  await evaluate(page, () => document.querySelector('#projectDialog .project-dialog__close').click())
  await sleep(500)
  const back = await evaluate(page, async () => {
    const m = await import('/js/site-state.js')
    return { stage: document.getElementById('chatDialog').dataset.chatStage, size: document.getElementById('chatDialog').dataset.chatSize, voiceActive: m.getSiteState().voiceActive }
  })
  out.push({
    claim: '1000: closing the project restores the docked card at the stored size, voice untouched',
    ok: back.stage === 'docked' && back.size === 'wide' && back.voiceActive,
    detail: JSON.stringify(back)
  })

  // N-P3: the chip below 1016 keeps today's behaviour - the modal over the dialog.
  await openProjectFromPage(page)
  await evaluate(page, () => {
    document.querySelector('#projectDialog [data-project-chip="summarize"]')?.scrollIntoView({ block: 'center' })
  })
  await sleep(200)
  const chipBox = await box(page, '#projectDialog [data-project-chip="summarize"]')
  if (chipBox) await clickAt(page, chipBox.cx, chipBox.cy)
  await sleep(800)
  const chip = await evaluate(page, () => ({
    stage: document.getElementById('chatDialog').dataset.chatStage,
    project: !document.getElementById('projectDialog').hidden
  }))
  out.push({
    claim: '1000 chip (N-P3): the chat goes modal over the still-open dialog',
    ok: Boolean(chipBox) && chip.stage === 'modal' && chip.project,
    detail: chipBox ? JSON.stringify(chip) : 'no project chip'
  })
  await setViewport(page, 1280, 900)
  return out
}

// ---------------------------------------------------------------- runner

const JOURNEYS = [
  ['the assistant yields the stage', journeyYieldsTheStage],
  ['the page still scrolls', journeyRealScrollWorks],
  ['Escape does not end the call', journeyEscapeDoesNotKillTheCall],
  ['the pill is usable on narrow', journeyPillIsUsableOnNarrow],
  ['the contact form stays reachable', journeyContactFormIsReachable],
  ['W1 first open is the wide docked window', journeyFirstOpenIsWide],
  ['W2 toggle right after the first open', journeyToggleRightAfterOpen],
  ['W4 the page is usable around the card', journeyPageUsableAroundTheCard],
  ['W4 no horizontal overflow at any width', journeyNoHorizontalOverflow],
  ['W5 narrow is unchanged', journeyNarrowUnchanged],
  ['W3/W6 minimise, restore, reload keep the size', journeyMinimizeRestoreKeepsSize],
  ['W7 motion', journeyTransitionMotion],
  ['W6 beside a project dialog (z-index drift)', journeyBesideProjectDialog],
  ['ADR-0029 a dialog reserves the chat column', journeyReservedColumn],
  ['ADR-0029 below 1016 the card tucks; the chip stays modal', journeyTuckBelow1016]
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
    // POLL until it answers. A fixed 900ms sleep lost the race on a cold start often enough
    // that the FIRST journey failed with "page never became ready" (2 of 4 runs, 2026-10-24)
    // while every later one passed - Chrome had loaded its connection-refused page.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const up = await fetch(`${ORIGIN}/index.html`).then((r) => r.ok, () => false)
      if (up) break
      await sleep(150)
    }
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
