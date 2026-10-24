#!/usr/bin/env node
/**
 * The staging Gemini Live voice pass (docs/plan-2026-09-port.md, "What cannot be verified
 * here"): barge-in over the greeting on the COLD path, voice chips (including one tapped
 * mid-greeting), navigation while speaking - run against the REAL Live API through a real
 * Chrome. Invariant #25 / ADR-0026 §7: until 2026-10-24 this probe asserted the regression
 * ("mic requested only AFTER the greeting", "greeting is not interrupted") as a pass. Those
 * claims are gone; it now asserts the visitor can cut the greeting off.
 *
 *     node scripts/qa/voice-stage-probe.mjs https://chat.marwanelgendy.link <speech.wav>
 *
 * The microphone is a FILE: Chrome's fake capture device plays <speech.wav> as the visitor's
 * voice from the moment getUserMedia runs (which, since ADR-0026 §2, is right after the
 * greeting is sent), and the permission prompt is auto-accepted. The instrument below DELAYS
 * the mic so the WAV's t=0 is the greeting's first audio frame: its leading silence is then
 * the offset into the greeting where the speech lands. Keep it short enough that the speech
 * goes out before the SERVER finishes sending the greeting (Live sends faster than real time),
 * or the server-side claims report INCONCLUSIVE and fail; ~1 s works for a several-second
 * greeting. The WAV needs a PLAIN header (RIFF, fmt,
 * data): macOS `say` writes a JUNK/FLLR chunk Chrome reads as silence, so on macOS:
 *   say -o raw.wav --data-format=LEI16@48000 "[[slnc 1000]] Show me your work. [[slnc 9000]]"
 *   python3 -c "import wave;r=wave.open('raw.wav');p=r.getparams();f=r.readframes(p.nframes);\
 *     w=wave.open('speech.wav','wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(p.framerate);w.writeframes(f)"
 * The audio-loudness claim below fails loudly if the file is still being read as silence. So this measures the
 * protocol and the page - what the model heard, what it called, what moved, whether the
 * session survived, which audio sources the page started and stopped - and NOT the human
 * half: how the permission sheet over the greeting looks and feels, and whether the cut
 * SOUNDS clean through real speakers. Those stay a human check (G3, human-staging gated).
 *
 * Journeys:
 *   - barge-in: the visitor speaks over the greeting; PLAYBACK must reach zero within VOICE_CUT_BUDGET_MS
 *     of the first voiced frame, `interrupted` must arrive before the greeting's
 *     turnComplete, and model audio for that turn must stop within GRACE_MS of it. The
 *     answer to the spoken question must then play to its end (no self-cut by a late
 *     transcript fragment, ADR-0026 addendum).
 *   - silent-mic control: the same start with the mic sending silence; the greeting must
 *     complete with no `interrupted` (the assistant does not barge in on itself).
 *   - chip mid-greeting (one chip, then two quick chips): a project chip tapped on the
 *     greeting's first play-start stops playback locally at once and the (last) chip's reply
 *     is heard (ADR-0026 §3.2's residual is a probe claim; a drained greeting is INCONCLUSIVE).
 *   - voice chips: a chip during a live call reaches the model and answers by voice.
 */

import { launch, goto, evaluate, sleep, findChrome } from './cdp.mjs'

const [ORIGIN, WAV] = process.argv.slice(2)
if (!ORIGIN || !WAV) {
  console.error('usage: voice-stage-probe.mjs <origin> <speech.wav>')
  process.exit(2)
}

// Model audio already in flight when `interrupted` is raised may still land; anything for the
// cut-off turn later than this after it means the server did not stop the turn.
const GRACE_MS = 500
// Voice onset -> playback silence (ADR-0026 addendum): covers Live's speech detection (server
// `interrupted`) or its input transcription (the client's 'voice_local' cut). Its own bound,
// NOT GRACE_MS, which counts from `interrupted`. The measured number is printed every run.
const VOICE_CUT_BUDGET_MS = 1500

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
        if (sc.modelTurn) { window.__vpGreetingAudioSeen = true; log('model-audio') }
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
          const chunk = m.realtimeInput.audio || (m.realtimeInput.mediaChunks || [])[0]
          const zeros = (b64) => btoa('\\0'.repeat(atob(b64).length))
          // The mic is live from the start (ADR-0026 §2), but the WAV's t=0 should be the
          // greeting's FIRST AUDIO FRAME, so its leading silence decides where in the greeting
          // the speech lands. A delay line: until that frame, every real frame is queued and
          // silence is sent; after it, each send carries the oldest queued frame. A silent-mic
          // journey (the control) zeroes every frame instead.
          if (chunk && chunk.data) {
            const q = (window.__vpMicQueue = window.__vpMicQueue || [])
            if (window.__VP_SILENT_MIC__ === true) chunk.data = zeros(chunk.data)
            else {
              q.push(chunk.data)
              chunk.data = window.__vpGreetingAudioSeen ? q.shift() : zeros(chunk.data)
            }
            data = JSON.stringify(m)
          }
          // Loudness of what is actually sent: a stream of zeros is "audio" to a frame counter.
          if (chunk && chunk.data) {
            const bin = atob(chunk.data)
            let peak = 0
            for (let i = 0; i + 1 < bin.length; i += 2) {
              const v = Math.abs(((bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i)) << 16 >> 16)
              if (v > peak) peak = v
            }
            window.__vpPeak = Math.max(window.__vpPeak || 0, peak)
            if (peak > 1000 && !window.__vpVoiced) {
              window.__vpVoiced = true
              // Detail = how much assistant audio was queued/sounding when the voice went out.
              log('first-voiced-frame', String(window.__vpPlaying || 0))
            }
            // Every voice ONSET (a voiced frame after >= 1.5 s without one) - the start of an
            // utterance, as the page's own rule counts it (ADR-0026 addendum).
            if (peak > 1000) {
              const nowT = performance.now()
              if (window.__vpLastVoicedAt === undefined || nowT - window.__vpLastVoicedAt >= 1500) log('voice-onset')
              window.__vpLastVoicedAt = nowT
            }
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
  // What the page PLAYS: every AudioBufferSourceNode it starts and stops. __vpPlaying is the
  // count started and neither stopped nor ended - assistant audio queued or sounding. The mic
  // uses a MediaStreamSource, so it never counts here.
  const ABS = window.AudioBufferSourceNode
  if (ABS) {
    window.__vpPlaying = 0
    const start = ABS.prototype.start
    const stop = ABS.prototype.stop
    // 'play-idle' = the moment nothing of the assistant is queued or sounding any more.
    const off = (node) => {
      if (!node.__vpOn) return false
      node.__vpOn = false
      window.__vpPlaying -= 1
      if (window.__vpPlaying === 0) log('play-idle')
      return true
    }
    ABS.prototype.start = function (...args) {
      if (!this.__vpOn) {
        this.__vpOn = true
        window.__vpPlaying += 1
        log('play-start')
        this.addEventListener('ended', () => { off(this) })
      }
      return start.apply(this, args)
    }
    ABS.prototype.stop = function (...args) {
      if (off(this)) log('play-stop')
      return stop.apply(this, args)
    }
  }
  // COLD visitor: the browser has not been asked yet. Chrome's fake-UI flag reports the
  // microphone as already granted, which sends the page down the WARM path; answering 'prompt'
  // here exercises the first-visit path invariant #25 is about (the mic must still be requested
  // at once, before the greeting completes).
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

// Invariant #25 on the cold path (ADR-0026 §7, G3). The greeting's turnComplete is the FIRST
// turnComplete: an interrupted turn still ends with one, after its tail.
function bargeInClaims (ev) {
  const { first, firstTurn, gum } = summarise(ev)
  const greetingAudio = first('model-audio')
  const voiced = first('first-voiced-frame')
  const cut = ev.find((e) => e.kind === 'interrupted' && firstTurn && e.t < firstTurn.t)
  const lateAudio = cut
    ? ev.filter((e) => e.kind === 'model-audio' && e.t > cut.t + GRACE_MS && e.t < firstTurn.t)
    : []
  // Measured against PLAYBACK, not the server: Live sends faster than real time, so its
  // turnComplete can land while seconds of greeting are still queued here. What the visitor
  // hears stops when the page's last source stops ('play-idle').
  const quietAfterVoice = voiced && ev.find((e) => e.kind === 'play-idle' && e.t >= voiced.t)
  const playingAtVoice = voiced ? Number(voiced.detail) : 0
  const lastStopBeforeVoice = [...ev].reverse().find((e) => (e.kind === 'play-stop' || e.kind === 'play-idle') && (!voiced || e.t <= voiced.t))
  // The server half is only testable when the speech went out BEFORE the server finished
  // sending; otherwise there is no turn for Live to interrupt (the client's 'voice_local' cut
  // covers that, and the playback claim above still measures it). Never a vacuous pass.
  const serverHalfTestable = Boolean(voiced && firstTurn && voiced.t < firstTurn.t)
  const inconclusive = 'INCONCLUSIVE: the speech went out after the server\'s turnComplete - shorten the WAV\'s leading silence'
  return [
    {
      claim: 'cold path: the mic is requested at once, BEFORE the greeting turn completes',
      ok: Boolean(gum && firstTurn && gum.t < firstTurn.t),
      detail: `getUserMedia@${gum && gum.t} turnComplete@${firstTurn && firstTurn.t}`
    },
    {
      claim: 'precondition: the visitor\'s speech goes out while the greeting is PLAYING (after its first audio, with audio queued or sounding)',
      ok: Boolean(voiced && greetingAudio && voiced.t > greetingAudio.t && playingAtVoice > 0),
      detail: `model-audio@${greetingAudio && greetingAudio.t} first-voiced-frame@${voiced && voiced.t} (sources playing: ${playingAtVoice}) server turnComplete@${firstTurn && firstTurn.t}`
    },
    {
      claim: `the visitor's voice silences the greeting: playback reaches zero within ${VOICE_CUT_BUDGET_MS} ms of the first voiced frame`,
      ok: Boolean(voiced && playingAtVoice > 0 && quietAfterVoice && quietAfterVoice.t - voiced.t <= VOICE_CUT_BUDGET_MS),
      detail: `first-voiced-frame@${voiced && voiced.t} play-idle@${quietAfterVoice && quietAfterVoice.t}` +
        ` (${quietAfterVoice && voiced ? quietAfterVoice.t - voiced.t : '?'} ms); playback ran ` +
        `${firstTurn && quietAfterVoice ? quietAfterVoice.t - firstTurn.t : '?'} ms past the server turnComplete` +
        `${lastStopBeforeVoice ? `; last play-stop before the voice @${lastStopBeforeVoice.t}` : ''}`
    },
    {
      claim: 'the visitor\'s voice cuts the greeting off at the server: `interrupted` arrives before the greeting\'s turnComplete',
      ok: serverHalfTestable && Boolean(cut),
      detail: !serverHalfTestable ? inconclusive : (cut ? `interrupted@${cut.t} turnComplete@${firstTurn.t}` : `no interrupted before turnComplete@${firstTurn && firstTurn.t}`)
    },
    {
      claim: `model audio for the cut-off greeting stops within ${GRACE_MS} ms of \`interrupted\``,
      ok: serverHalfTestable && Boolean(cut) && lateAudio.length === 0,
      detail: !serverHalfTestable ? inconclusive : (cut ? (lateAudio.length ? `model-audio at ${lateAudio.map((e) => e.t).join(', ')} (interrupted@${cut.t})` : '') : 'no interrupted to measure from')
    }
  ]
}

// No SELF-cut (the critic's false positive, ADR-0026 addendum): the answer to the spoken
// question plays to its natural end. From the answer's first play-start until the visitor's
// next voice onset (or the end of the run) no source may be stop()ped - every stop is an
// interrupt - and playback must go idle on its own.
function answerPlaysToItsEnd (ev) {
  const { firstTurn } = summarise(ev)
  const voiced = ev.find((e) => e.kind === 'first-voiced-frame')
  const from = Math.max(firstTurn ? firstTurn.t : Infinity, voiced ? voiced.t : Infinity)
  const answerStart = ev.find((e) => e.kind === 'play-start' && e.t > from)
  const nextOnset = answerStart && ev.find((e) => e.kind === 'voice-onset' && e.t > answerStart.t)
  const until = nextOnset ? nextOnset.t : Infinity
  const inWindow = answerStart ? ev.filter((e) => e.t >= answerStart.t && e.t < until) : []
  const stops = inWindow.filter((e) => e.kind === 'play-stop')
  const ended = inWindow.find((e) => e.kind === 'play-idle')
  return {
    claim: 'the answer to the spoken question plays to its end (no self-cut by a late transcript)',
    ok: Boolean(answerStart && ended && stops.length === 0),
    detail: answerStart
      ? `answer play-start@${answerStart.t}, play-stop in window: ${stops.map((e) => e.t).join(', ') || 'none'}, play-idle@${ended && ended.t}, next voice-onset@${nextOnset && nextOnset.t}`
      : 'no answer audio after the greeting and the voice'
  }
}

// The hero mic opens the panel AWAITING a voice start (js/chat.js openPanelAwaitingVoiceStart);
// the session begins on the second tap, "Start voice chat".
async function startVoice (page, tag) {
  await goto(page, `${ORIGIN}/?${tag}=${Date.now()}`)
  await sleep(2000)
  await evaluate(page, () => document.getElementById('heroVoiceMic').click())
  await sleep(1200)
  await evaluate(page, () => document.getElementById('chatVoiceStartBtn').click())
}


// Control (G3): with a SILENT mic streaming during the greeting, the greeting completes and is
// not interrupted - the assistant does not barge in on itself through its own audio.
async function silentMicControl (page) {
  const out = []
  await startVoice(page, 'voicesilent')
  await sleep(20000)
  const ev = await timeline(page)
  const { first, firstTurn, gum } = summarise(ev)
  const audio = await evaluate(page, () => ({ frames: window.__vpAudioFrames || 0, peak: window.__vpPeak || 0 }))
  out.push({ claim: 'control: the mic is live during the greeting (requested before turnComplete, frames streamed)', ok: Boolean(gum && firstTurn && gum.t < firstTurn.t && audio.frames > 10), detail: `getUserMedia@${gum && gum.t} turnComplete@${firstTurn && firstTurn.t} ${JSON.stringify(audio)}` })
  out.push({ claim: 'control: what the mic sends is silence', ok: audio.peak === 0, detail: JSON.stringify(audio) })
  const cut = ev.find((e) => e.kind === 'interrupted' && (!firstTurn || e.t < firstTurn.t))
  out.push({ claim: 'control: with a silent mic the greeting completes (turnComplete, no `interrupted`)', ok: Boolean(first('model-audio') && firstTurn && !cut), detail: cut ? `interrupted@${cut.t}` : `turnComplete@${firstTurn && firstTurn.t}` })
  return out
}

// A chip tapped WHILE THE GREETING PLAYS (silent mic, so only the chip can cut it): playback
// stops locally at once - read synchronously around the click, so no server frame can have
// done it - nothing more of the greeting plays, and the chip's reply is heard. ADR-0026 §3.2's
// residual: if Live abandoned the greeting without a turnComplete, the gate would stay shut and
// the last claim fails.
//
// Timing is the whole point, so the project card is opened BEFORE voice starts (its chips are
// already in the DOM) and the tap happens in-page on the greeting's first play-start, polled
// every 10 ms - not from the driver, whose round trips let a short greeting finish first. If the
// server had still finished the greeting before the tap, the residual claim is INCONCLUSIVE and
// FAILS: a pass there would prove nothing about the gate.
// `count` chips are tapped `gapMs` apart (the two-quick-chips run: the LAST chip's reply must
// not be swallowed by the turns the earlier taps abandoned).
async function chipsMidGreeting (page, { tag, count, gapMs }) {
  const out = []
  await goto(page, `${ORIGIN}/?${tag}=${Date.now()}`)
  await sleep(2000)
  const chips = await evaluate(page, async () => {
    const projects = await import('/js/projects.js')
    projects.requestProjectOpen('apptio', { origin: 'visitor' })
    for (let i = 0; i < 60; i++) {
      const found = [...document.querySelectorAll('#projectDialog [data-project-chip]')].map((b) => b.dataset.projectChip)
      if (found.length) return found
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return []
  })
  out.push({ claim: `mid-greeting: the project card shows at least ${count} chip(s) before voice starts`, ok: chips.length >= count, detail: JSON.stringify(chips) })
  if (chips.length < count) return out
  await evaluate(page, () => document.getElementById('heroVoiceMic').click())
  await sleep(1200)
  await evaluate(page, () => document.getElementById('chatVoiceStartBtn').click())
  const taps = await evaluate(page, async ({ names, gap }) => {
    const deadline = performance.now() + 20000
    while (!(window.__vp || []).some((e) => e.kind === 'play-start')) {
      if (performance.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const out = []
    for (const name of names) {
      const btn = document.querySelector(`#projectDialog [data-project-chip="${name}"]`)
      if (!btn) { out.push({ name, missing: true, at: (window.__vp || []).length }); continue }
      const before = window.__vpPlaying || 0
      btn.click()
      out.push({ name, before, after: window.__vpPlaying || 0, at: (window.__vp || []).length })
      await new Promise((resolve) => setTimeout(resolve, gap))
    }
    return out
  }, { names: chips.slice(0, count), gap: gapMs })
  out.push({ claim: 'mid-greeting: the greeting starts playing', ok: Boolean(taps), detail: taps ? '' : 'no play-start in 20 s' })
  if (!taps) return out
  await sleep(18000)
  const all = await timeline(page)
  const first = taps[0]
  const last = taps[taps.length - 1]
  const tapT = (tap) => (all[tap.at - 1] ? all[tap.at - 1].t : 0)
  const greetingDone = all.slice(0, first.at).some((e) => e.kind === 'turnComplete')
  const afterFirst = all.slice(first.at)
  const abandonedEnd = greetingDone ? null : afterFirst.find((e) => e.kind === 'turnComplete')
  const greetingTail = abandonedEnd ? afterFirst.filter((e) => e.kind === 'play-start' && e.t < abandonedEnd.t) : []
  // The last chip's reply = the FINAL turn after the last tap: every turn a tap abandoned ends
  // with its own turnComplete first, so the reply's audio is what plays between the
  // second-to-last boundary (or the last tap) and the last turnComplete (or the end of the run).
  const afterLast = all.slice(last.at)
  const ends = afterLast.filter((e) => e.kind === 'turnComplete')
  const lastTurnEnd = ends[ends.length - 1]
  const replyFrom = ends.length >= 2 ? ends[ends.length - 2].t : tapT(last)
  const replyTo = lastTurnEnd ? lastTurnEnd.t : Infinity
  const replyPlays = afterLast.filter((e) => e.kind === 'play-start' && e.t > replyFrom && e.t <= replyTo)
  const said = afterLast.filter((e) => e.kind === 'said' && e.t > replyFrom && e.t <= replyTo).map((e) => e.detail).join('')
  const sent = all.filter((e) => e.kind === 'clientContent').length
  const closed = afterFirst.find((e) => e.kind === 'ws-close')
  out.push({ claim: 'precondition: greeting audio was playing when the first chip was tapped', ok: first.before > 0, detail: JSON.stringify(taps) })
  out.push({ claim: 'every chip tap stops playback locally at once (read synchronously around the click)', ok: first.before > 0 && taps.every((tap) => tap.after === 0), detail: JSON.stringify(taps) })
  out.push({
    claim: 'nothing more of the cut-off greeting plays after the tap (the gate held until its turnComplete)',
    ok: !greetingDone && Boolean(abandonedEnd) && greetingTail.length === 0,
    detail: greetingDone
      ? 'INCONCLUSIVE: the server had finished the greeting before the tap, so the gate was never tested'
      : (abandonedEnd ? `play-start before the greeting's turnComplete@${abandonedEnd.t}: ${greetingTail.length}` : 'no turnComplete for the abandoned greeting (the ADR-0026 §3.2 residual - the gate would stay shut)')
  })
  out.push({ claim: `every chip went to the call (${count} clientContent after the greeting)`, ok: sent >= count + 1, detail: `clientContent sent: ${sent}` })
  out.push({
    claim: `the ${count > 1 ? 'last ' : ''}chip's reply is heard (played, by voice, about the project)`,
    ok: replyPlays.length > 0 && /apptio|ibm|spark|pipeline|financial|cost|cloud/i.test(said),
    detail: `reply play-starts: ${replyPlays.length} | last turnComplete@${lastTurnEnd && lastTurnEnd.t} | voice said: ${said.slice(0, 160)}`
  })
  out.push({ claim: 'the call survives the chip taps (no socket close)', ok: !closed, detail: closed ? closed.detail : '' })
  return out
}

const chipMidGreeting = (page) => chipsMidGreeting(page, { tag: 'voicechipmid', count: 1, gapMs: 0 })
const twoChipsMidGreeting = (page) => chipsMidGreeting(page, { tag: 'voicechips2', count: 2, gapMs: 300 })

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
  out.push(...bargeInClaims(ev))
  out.push(answerPlaysToItsEnd(ev))
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
  const journeys = [
    ['cold-path barge-in over the greeting, navigation while speaking', greetingAndNavigation, {}],
    ['silent-mic control: the greeting completes uninterrupted', silentMicControl, { silentMic: true }],
    ['chip mid-greeting: local stop, reply heard', chipMidGreeting, { silentMic: true }],
    ['two quick chips mid-greeting: the last reply is not swallowed', twoChipsMidGreeting, { silentMic: true }],
    ['voice chips', voiceChip, {}]
  ]
  for (const [name, journey, { silentMic }] of journeys) {
    const page = await launch({
      width: 1280, height: 900,
      // --no-sandbox: MEASURED, the audio service's sandbox cannot read the WAV and the fake
      // device silently captures zeros (peak 0) - the model then "hears" nothing and the run
      // looks like a voice defect. Acceptable here: a throwaway profile that visits one host.
      chromeArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', '--no-sandbox']
    })
    await page.send('Page.enable')
    // Same Chrome flags (one WAV per run): the silent journeys zero every mic frame instead.
    if (silentMic) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__VP_SILENT_MIC__ = true' })
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
