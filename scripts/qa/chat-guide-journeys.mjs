#!/usr/bin/env node
/**
 * Track C journeys against a REAL chat backend and the real model (backlog items 5-7).
 *
 *     node scripts/qa/chat-guide-journeys.mjs https://chat.marwanelgendy.link
 *
 * Exit 0 when every claim holds, 1 otherwise. NOT part of `node --test`: it launches Chrome
 * and calls a live model, so it is run by hand against stage or prod.
 *
 * test/agent-guide.test.mjs pins the WIRING with a canned reply: given a navigate or
 * start-tour action, the page moves. What it cannot pin is the model's half - that a visitor
 * saying "show me your work" gets a navigate action at all, that "show me around" gets
 * start_tour, and that an open question about experience gets no résumé. Those are claims
 * about a model, so they are measured here, on the real host, and can flake with it: a FAIL
 * is re-run once before it is believed, and a pass is recorded with the host it ran on.
 */

import { launch, goto, evaluate, sleep, findChrome } from './cdp.mjs'

const ORIGIN = process.argv[2]
if (!ORIGIN) {
  console.error('usage: chat-guide-journeys.mjs <origin>  (a host with a live chat backend)')
  process.exit(2)
}

const section = (page) => evaluate(page, async () => (await import('/js/site-state.js')).getSiteState().section)

const buttons = (page) => evaluate(page, () => [...document.querySelectorAll('#chatMessages .chat-msg__action')]
  .map((b) => ({ action: b.dataset.action, step: b.dataset.step || null, label: b.textContent })))

const assistantCount = (page) => evaluate(page, () => document.querySelectorAll('#chatMessages .chat-msg--assistant').length)

async function ask (page, text) {
  await goto(page, `${ORIGIN}/?guide=${Date.now()}`)
  await sleep(1500)
  await evaluate(page, () => { window.dispatchEvent(new CustomEvent('gvp:open-chat')) })
  await sleep(700)
  await evaluate(page, (t) => {
    const input = document.getElementById('chatComposerInput')
    input.value = t
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('chatComposer').requestSubmit()
  }, text)
  // Wait for the reply to finish streaming: the composer is busy until it does.
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const done = await evaluate(page, () => !document.querySelector('#chatMessages .chat-msg--streaming')
      && document.querySelectorAll('#chatMessages .chat-msg--assistant').length > 0)
    if (done) break
  }
  await sleep(600)
}

async function journeyShowMeTheWork (page) {
  await ask(page, 'Show me your work')
  const where = await section(page)
  return [{ claim: '"show me your work" moves the page to the portfolio', ok: where === 'portfolio', detail: `section=${where}` }]
}

async function journeyTour (page) {
  const out = []
  await ask(page, 'Show me around')
  let where = await section(page)
  let btns = await buttons(page)
  out.push({ claim: '"show me around" starts the tour on the page', ok: btns.some((b) => b.action === 'tour-next') && where === 'portfolio', detail: `section=${where} buttons=${JSON.stringify(btns)}` })
  const visited = [where]
  for (let hop = 0; hop < 6; hop++) {
    btns = await buttons(page)
    const next = [...btns].reverse().find((b) => b.action === 'tour-next')
    if (!next) break
    const before = await assistantCount(page)
    await evaluate(page, (step) => {
      const all = [...document.querySelectorAll('#chatMessages .chat-msg__action[data-action="tour-next"]')]
      all.filter((b) => b.dataset.step === step).pop().click()
    }, next.step)
    await sleep(900)
    out.push({ claim: `Next stop ${next.step} narrates`, ok: (await assistantCount(page)) === before + 1 })
    visited.push(await section(page))
  }
  btns = await buttons(page)
  out.push({ claim: 'the tour visits labs on the way', ok: visited.includes('labs'), detail: visited.join(' > ') })
  out.push({ claim: 'the tour ends with a way to get in touch', ok: btns.some((b) => b.action === 'open-contact'), detail: JSON.stringify(btns.slice(-2)) })
  return out
}

async function journeyNoResumeByDefault (page) {
  await ask(page, 'Tell me about his experience')
  const btns = await buttons(page)
  return [{ claim: 'an open question about experience does not offer the résumé PDF', ok: !btns.some((b) => b.action === 'open-resume'), detail: JSON.stringify(btns) }]
}

async function journeyResumeWhenAsked (page) {
  await ask(page, 'Can I download his resume PDF?')
  const btns = await buttons(page)
  return [{ claim: 'an explicit résumé request still gets the résumé', ok: btns.some((b) => b.action === 'open-resume'), detail: JSON.stringify(btns) }]
}

const JOURNEYS = [
  ['text navigation moves the page', journeyShowMeTheWork],
  ['"show me around" runs a guided tour', journeyTour],
  ['the agent leads with the work', journeyNoResumeByDefault],
  ['the résumé is there when asked for', journeyResumeWhenAsked]
]

async function main () {
  if (!findChrome()) {
    console.error('No Chrome or Chromium found - this harness needs one. Skipping is not a pass.')
    process.exit(2)
  }
  const page = await launch({ width: 1280, height: 900 })
  const results = []
  try {
    for (const [name, journey] of JOURNEYS) {
      let rows
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          rows = await journey(page)
        } catch (err) {
          rows = [{ claim: 'journey ran to completion', ok: false, detail: String(err && err.message) }]
        }
        if (rows.every((r) => r.ok)) break
        if (attempt === 1) console.log(`  (re-running "${name}" once - a model claim can flake)`)
      }
      for (const r of rows) results.push({ journey: name, ...r })
    }
  } finally {
    await page.close()
  }
  let failed = 0
  let current = null
  for (const r of results) {
    if (r.journey !== current) { current = r.journey; console.log(`\n${current}`) }
    if (!r.ok) failed++
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.claim}${r.ok || !r.detail ? '' : `\n       ${r.detail}`}`)
  }
  console.log(`\n${results.length - failed}/${results.length} claims held on ${ORIGIN}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
