#!/usr/bin/env node
/**
 * The staging Gemini Live voice pass (docs/plan-2026-09-port.md, "What cannot be verified
 * here"): greeting uninterrupted by the deferred mic prompt, voice chips, navigation while
 * speaking - run against the REAL Live API through a real Chrome.
 *
 *     node scripts/qa/voice-stage-probe.mjs https://chat.marwanelgendy.link <speech.wav>
 *
 * The microphone is a FILE: Chrome's fake capture device plays <speech.wav> as the visitor's
 * voice, and the permission prompt is auto-accepted. The WAV needs a PLAIN header (RIFF, fmt,
 * data): macOS `say` writes a JUNK/FLLR chunk Chrome reads as silence, so on macOS:
 *   say -o raw.wav --data-format=LEI16@48000 "[[slnc 3000]] Show me your work. [[slnc 9000]]"
 *   python3 -c "import wave;r=wave.open('raw.wav');p=r.getparams();f=r.readframes(p.nframes);\
 *     w=wave.open('speech.wav','wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(p.framerate);w.writeframes(f)"
 * The audio-loudness claim below fails loudly if the file is still being read as silence. So this measures the
 * protocol and the page - what the model heard, what it called, what moved, whether the
 * session survived - and NOT the human half: how the permission prompt looks and feels, and
 * whether the greeting SOUNDS uninterrupted through real speakers. Those stay a human check.
 */

import { launch, goto, evaluate, sleep, findChrome } from './cdp.mjs'

const [ORIGIN, WAV] = process.argv.slice(2)
if (!ORIGIN || !WAV) {
  console.error('usage: voice-stage-probe.mjs <origin> <speech.wav>')
  process.exit(2)
}

// Installed before any page script: a timeline of what the voice path actually did.
const INSTRUMENT = `(() => {
  const t0 = performance.now()
  const log = (kind, detail) => (window.__vp = window.__vp || []).push({ t: Math.round(performance.now() - t0), kind, detail })
  const WS = window.WebSocket
  window.WebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new WS(url) : new WS(url, protocols)
    log('ws-open-attempt', String(url).replace(/[?].*$/, ''))
    ws.addEventListener('open', () => log('ws-open'))
    ws.addEventListener('close', (e) => log('ws-close', e.code + ' ' + e.reason))
    ws.addEventListener('message', async (e) => {
      let text = e.data
      if (typeof text !== 'string') { try { text = await new Response(e.data).text() } catch (_) { return } }
      let m; try { m = JSON.parse(text) } catch (_) { return }
      if (m.setupComplete) log('setupComplete')
      const sc = m.serverContent
      if (sc) {
        if (sc.modelTurn) log('model-audio')
        if (sc.interrupted) log('interrupted')
        if (sc.turnComplete) log('turnComplete')
        if (sc.inputTranscription && sc.inputTranscription.text) log('heard', sc.inputTranscription.text)
        if (sc.outputTranscription && sc.outputTranscription.text) log('said', sc.outputTranscription.text)
      }
      if (m.toolCall) log('toolCall', (m.toolCall.functionCalls || []).map((c) => c.name + JSON.stringify(c.args || {})).join(' '))
    })
    const send = ws.send.bind(ws)
    ws.send = (data) => {
      try {
        const m = JSON.parse(data)
        if (m.realtimeInput) {
          window.__vpAudioFrames = (window.__vpAudioFrames || 0) + 1
          if (window.__vpAudioFrames === 1) log('first-audio-frame', JSON.stringify(Object.keys(m.realtimeInput)))
          // Loudness of what is actually sent: a stream of zeros is "audio" to a frame counter.
          const chunk = m.realtimeInput.audio || (m.realtimeInput.mediaChunks || [])[0]
          if (chunk && chunk.data) {
            const bin = atob(chunk.data)
            let peak = 0
            for (let i = 0; i + 1 < bin.length; i += 2) {
              const v = Math.abs(((bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i)) << 16 >> 16)
              if (v > peak) peak = v
            }
            window.__vpPeak = Math.max(window.__vpPeak || 0, peak)
          }
        }
        if (m.toolResponse) log('toolResponse', JSON.stringify(m.toolResponse.functionResponses.map((r) => r.response && (r.response.result || r.response.error))))
        else if (m.clientContent) log('clientContent', JSON.stringify(m.clientContent).slice(0, 200))
      } catch (_) {}
      return send(data)
    }
    return ws
  }
  Object.assign(window.WebSocket, WS)
  window.WebSocket.prototype = WS.prototype
  // COLD visitor: the browser has not been asked yet. Chrome's fake-UI flag reports the
  // microphone as already granted, which sends the page down the WARM path (attach at once, no
  // prompt to defer); answering 'prompt' here exercises the deferred path the gate is about.
  if (window.__VP_COLD__ !== false && navigator.permissions && navigator.permissions.query) {
    const q = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = (d) => (d && d.name === 'microphone'
      ? Promise.resolve({ state: 'prompt', onchange: null, addEventListener () {}, removeEventListener () {} })
      : q(d))
  }
  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  if (gum) navigator.mediaDevices.getUserMedia = (c) => { log('getUserMedia'); return gum(c) }
})()`

const timeline = (page) => evaluate(page, () => window.__vp || [])
const section = (page) => evaluate(page, async () => (await import('/js/site-state.js')).getSiteState().section)

function summarise (events) {
  const first = (k) => events.find((e) => e.kind === k)
  const firstTurn = first('turnComplete')
  const gum = first('getUserMedia')
  const said = events.filter((e) => e.kind === 'said').map((e) => e.detail).join('')
  const heard = events.filter((e) => e.kind === 'heard').map((e) => e.detail).join('')
  return { first, firstTurn, gum, said, heard }
}

async function greetingAndNavigation (page) {
  const out = []
  await goto(page, `${ORIGIN}/?voiceprobe=${Date.now()}`)
  await sleep(2000)
  // The hero mic opens the panel AWAITING a voice start (js/chat.js openPanelAwaitingVoiceStart);
  // the session begins on the second tap, "Start voice chat". Tapping only the hero mic
  // leaves an empty timeline - which is the design, not a dead button.
  await evaluate(page, () => document.getElementById('heroVoiceMic').click())
  await sleep(1200)
  const cta = await evaluate(page, () => {
    const b = document.getElementById('chatVoiceStartBtn')
    const r = b && b.getBoundingClientRect()
    return Boolean(b && r.width > 0)
  })
  out.push({ claim: 'the hero mic opens the panel with a visible "Start voice chat"', ok: cta })
  await evaluate(page, () => document.getElementById('chatVoiceStartBtn').click())
  await sleep(30000)
  const ev = await timeline(page)
  const { first, firstTurn, gum, said, heard } = summarise(ev)
  out.push({ claim: 'the hero mic starts a Live session (socket opens, setup completes)', ok: Boolean(first('ws-open') && first('setupComplete')), detail: JSON.stringify(ev.slice(0, 6)) })
  out.push({ claim: 'the model greets (audio arrives, first turn completes)', ok: Boolean(first('model-audio') && firstTurn), detail: `said: ${said.slice(0, 160)}` })
  out.push({
    claim: 'the mic is requested only AFTER the greeting turn completes (deferred prompt)',
    ok: Boolean(gum && firstTurn && gum.t >= firstTurn.t),
    detail: `getUserMedia@${gum && gum.t} turnComplete@${firstTurn && firstTurn.t}`
  })
  const interruptedEarly = ev.find((e) => e.kind === 'interrupted' && firstTurn && e.t < firstTurn.t)
  out.push({ claim: 'the greeting is not interrupted before it completes', ok: !interruptedEarly, detail: interruptedEarly ? `interrupted@${interruptedEarly.t}` : '' })
  const audio = await evaluate(page, () => ({ frames: window.__vpAudioFrames || 0, peak: window.__vpPeak || 0 }))
  out.push({ claim: 'mic audio is streamed to the model, and it is not silence', ok: audio.frames > 10 && audio.peak > 1000, detail: JSON.stringify(audio) })
  out.push({ claim: 'the model hears the spoken request through the mic', ok: /work/i.test(heard), detail: `heard: ${heard.slice(0, 160)}` })
  const nav = ev.find((e) => e.kind === 'toolCall' && /navigate_to_section|open_project|start_tour/.test(e.detail))
  out.push({ claim: 'the spoken request produces a navigation tool call', ok: Boolean(nav), detail: nav ? nav.detail : JSON.stringify(ev.filter((e) => e.kind === 'toolCall')) })
  const where = await section(page)
  out.push({ claim: 'the page moved to the work', ok: where === 'portfolio', detail: `section=${where}` })
  const navT = nav ? nav.t : Infinity
  const closedAfter = ev.find((e) => e.kind === 'ws-close' && e.t > navT)
  const spokeAfter = ev.find((e) => e.kind === 'model-audio' && e.t > navT)
  out.push({ claim: 'the call survives the navigation (no socket close after it)', ok: Boolean(nav) && !closedAfter, detail: closedAfter ? closedAfter.detail : '' })
  out.push({ claim: 'the model keeps talking after the page moves (navigation while speaking)', ok: Boolean(spokeAfter), detail: `said: ${said.slice(-200)}` })
  return out
}

// "Voice chips", measured as what shipped: ADR-0017 §7.5 made the project chips canned TEXT
// prompts (the plan's 🔊 voice-first variant was not adopted). The gate question is therefore
// whether a chip tapped DURING a live voice call reaches the model and leaves the call alive.
async function voiceChip (page) {
  const out = []
  await goto(page, `${ORIGIN}/?voicechip=${Date.now()}`)
  await sleep(2000)
  await evaluate(page, () => document.getElementById('heroVoiceMic').click())
  await sleep(1200)
  await evaluate(page, () => document.getElementById('chatVoiceStartBtn').click())
  await sleep(14000)
  const opened = await evaluate(page, async () => {
    const projects = await import('/js/projects.js')
    const r = projects.requestProjectOpen('apptio', { origin: 'visitor' })
    await new Promise((res) => setTimeout(res, 1200))
    const chips = [...document.querySelectorAll('#projectDialog [data-project-chip]')].map((b) => b.dataset.projectChip)
    return { r, chips }
  })
  out.push({ claim: 'a project card shows its chips during a live call', ok: opened.chips.length === 3, detail: JSON.stringify(opened) })
  if (!opened.chips.length) return out
  const mark = (await timeline(page)).length
  await evaluate(page, () => document.querySelector('#projectDialog [data-project-chip="summarize"]').click())
  await sleep(18000)
  const ev = (await timeline(page)).slice(mark)
  const said = ev.filter((e) => e.kind === 'said').map((e) => e.detail).join('')
  const transcript = await evaluate(page, () => [...document.querySelectorAll('#chatMessages .chat-msg--assistant')].map((m) => m.textContent).join(' ').slice(-400))
  const closed = ev.find((e) => e.kind === 'ws-close')
  const sentChip = ev.find((e) => e.kind === 'clientContent' && /summari[sz]e/i.test(e.detail || ''))
  const viaText = (await evaluate(page, () => [...document.querySelectorAll('#chatMessages .chat-msg--user')].map((m) => m.textContent).join(' | ')))
  out.push({
    claim: "the chip's prompt is put to the model over the live call (not only a site note)",
    ok: Boolean(sentChip),
    detail: sentChip ? sentChip.detail : `no clientContent with the prompt; user messages: ${viaText.slice(-200)}`
  })
  out.push({ claim: 'the call survives the chip tap (no socket close)', ok: !closed, detail: closed ? closed.detail : '' })
  out.push({
    claim: 'the chip reaches the model and it answers about that project',
    ok: /apptio|ibm|spark|pipeline|financial/i.test(said + ' ' + transcript),
    detail: `voice said: ${said.slice(0, 160)} | transcript: ${transcript.slice(-160)}`
  })
  out.push({ claim: 'the answer comes back by VOICE (the modality the visitor is in)', ok: /apptio|ibm|spark|pipeline|financial/i.test(said), detail: `voice said: ${said.slice(0, 160)}` })
  return out
}

async function main () {
  if (!findChrome()) { console.error('No Chrome found - skipping is not a pass.'); process.exit(2) }
  const results = []
  for (const [name, journey] of [['greeting, deferred mic, navigation while speaking', greetingAndNavigation], ['voice chips', voiceChip]]) {
    const page = await launch({
      width: 1280, height: 900,
      // --no-sandbox: MEASURED, the audio service's sandbox cannot read the WAV and the fake
      // device silently captures zeros (peak 0) - the model then "hears" nothing and the run
      // looks like a voice defect. Acceptable here: a throwaway profile that visits one host.
      chromeArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
    })
    await page.send('Page.enable')
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    try {
      for (const r of await journey(page)) results.push({ journey: name, ...r })
    } catch (err) {
      results.push({ journey: name, claim: 'journey ran to completion', ok: false, detail: String(err && err.stack) })
    } finally {
      await page.close()
    }
  }
  let failed = 0
  let current = null
  for (const r of results) {
    if (r.journey !== current) { current = r.journey; console.log(`\n${current}`) }
    if (!r.ok) failed++
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.claim}${r.detail ? `\n       ${r.detail}` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} claims held on ${ORIGIN}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
