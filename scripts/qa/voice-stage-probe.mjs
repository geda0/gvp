#!/usr/bin/env node
/**
 * The staging Gemini Live voice pass, run against the REAL Live API through a real Chrome:
 * mic first then greet on the cold path (ADR-0028), barge-in over the greeting (invariant #25),
 * the silent-mic control and a raw echo measurement, the permission variants (deny / ignore /
 * hang up), voice chips (including ones tapped mid-greeting) and navigation while speaking.
 *
 *     node scripts/qa/voice-stage-probe.mjs https://chat.marwanelgendy.link <speech.wav> [--local <dir>]
 *
 * --local <dir> serves the page's own files (index.html, js/, css/, data/ …) from <dir> UNDER the
 * stage origin (CDP Fetch interception), so a working tree is probed against the stage chat API
 * without deploying it — the stage API's CORS only admits the stage origin, never localhost.
 * Anything not found in <dir> (fonts, gtag, the APIs) goes to the network.
 *
 * VP_ONLY=<substring> runs only the journeys whose name contains it; VP_DUMP=1 prints each
 * journey's timeline; VP_ECHO_GAIN (default 1) scales the echo journey's loopback. A claim
 * printed INFO is a measurement kept on record, not judged (it never fails the run).
 *
 * THE MICROPHONE IS A WEBAUDIO GRAPH, NOT CHROME'S FAKE DEVICE (backlog F5). On macOS the
 * fake-device getUserMedia hangs, so the old file-backed capture could not run here at all. The
 * page's getUserMedia is replaced by a simulated permission bubble that the journey answers
 * (grant after N ms / deny / never) and, on a grant, hands the page a MediaStreamDestination
 * stream fed by one of:
 *   - 'speech': <speech.wav>, decoded in-page and started on the greeting's first play-start —
 *     so the WAV's own leading silence is the offset into the greeting where the visitor speaks
 *     (~1 s). Any WAV Chrome can decode works (macOS `say -o x.wav --data-format=LEI16@24000`).
 *   - 'echo': the greeting's OWN audio, every buffer the page plays mirrored into the mic at
 *     VP_ECHO_GAIN (1 = the level the page plays it at), started and stopped with the page's
 *     sources — the loopback that cut the greeting before ADR-0028.
 *   - 'silent': nothing.
 * The Permissions API is stubbed to the journey's state ('prompt' = first visit; 'granted' =
 * warm), and flips to what the bubble answered. What this does NOT measure: the real browser
 * sheet, real speakers and the real echo canceller — a WebAudio stream bypasses AEC, so the
 * echo journey measures Live against RAW echo (it interrupts; see coldGrantEcho) and whether
 * the real AEC removes it stays the owner's check (design-notes P2 [human]).
 *
 * Journeys (design-notes P1/P2 [qa], ADR-0028 §6, invariant #25):
 *   - cold grant, silent mic: the bubble is answered Allow after GRANT_DELAY_MS; the hint shows
 *     within HINT_MS of the tap and leaves within HINT_MS of the grant; no greeting before the
 *     grant; the mic's first frame goes out before the greeting's first audio, which arrives
 *     within GREETING_AFTER_GRANT_MS of the grant; the greeting plays uncut to its
 *     turnComplete; telemetry chat_voice_start {permissionBefore: 'prompt', outcome: 'granted'}
 *     leaves the page.
 *   - cold grant, echo loopback (INFO): does Live interrupt the greeting on its own raw audio.
 *   - cold grant, speech 1 s into the greeting: `interrupted` before the greeting's turnComplete,
 *     playback silent within VOICE_CUT_BUDGET_MS of the first voiced frame, the answer plays to
 *     its end, the spoken request navigates and the call survives the move.
 *   - deny: no greeting audio ever, the text fallback (greeting in the transcript, denied copy,
 *     composer focused) within FALLBACK_MS, the socket closed.
 *   - ignore: the session closes at the permission timeout, no greeting audio ever, the
 *     "no access yet" copy, Start enabled.
 *   - hang up 1 s into the wait: no greeting audio, the socket closed at once, a late grant's
 *     track ended (mic indicator off), no error copy.
 *   - warm (already granted): the hint never appears, telemetry wait 0.
 *   - chips mid-greeting (one, then two quick ones) and voice chips during a call.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve, sep } from 'node:path'
import { launch, goto, evaluate, sleep, findChrome } from './cdp.mjs'

const args = process.argv.slice(2)
const localAt = args.indexOf('--local')
const LOCAL_ROOT = localAt >= 0 ? resolve(args[localAt + 1] || '.') : null
const [ORIGIN, WAV] = args.filter((_, i) => localAt < 0 || (i !== localAt && i !== localAt + 1))
if (!ORIGIN || !WAV) {
  console.error('usage: voice-stage-probe.mjs <origin> <speech.wav> [--local <dir>]')
  process.exit(2)
}
const WAV_B64 = readFileSync(WAV).toString('base64')
const ECHO_GAIN = Number(process.env.VP_ECHO_GAIN || 1)

// Model audio already in flight when `interrupted` is raised may still land; anything for the
// cut-off turn later than this after it means the server did not stop the turn.
const GRACE_MS = 500
// Voice onset -> playback silence (ADR-0026 addendum). Its own bound, NOT GRACE_MS.
const VOICE_CUT_BUDGET_MS = 1500
// design-notes P2 [qa]: the simulated bubble is answered after this; the greeting's first audio
// must arrive no earlier than the grant and at most GREETING_AFTER_GRANT_MS after it.
const GRANT_DELAY_MS = 2000
const GREETING_AFTER_GRANT_MS = 1500
// design-notes P1 [qa]: the hint shows within this of the tap and leaves within this of the grant.
const HINT_MS = 300
// design-notes P2 [qa]: the deny fallback is visible within this of the deny.
const FALLBACK_MS = 1000
// Mirrors VOICE_PERMISSION_WAIT_MS in js/chat-live.js (ADR-0028 addendum, N-P2).
const PERMISSION_WAIT_MS = 20000

const MIC_PERMISSION_HINT = 'Your browser is asking for the microphone — choose “Allow while visiting the site” so we don\'t ask again.'
const MIC_DISMISSED_MSG = 'No microphone access yet — tap Start voice chat to be asked again.'
const DENIED_COPY = 'Microphone access was denied. Allow the mic for this site in your browser settings.'
const GREETING_COLD = 'Hi! I\'m Marwan\'s AI assistant. What would you like to know about his work?'

// Installed before any page script, after window.__VP__ (the journey's config): a timeline of
// what the voice path did, the simulated permission bubble, and the WebAudio microphone.
const INSTRUMENT = `(() => {
  const cfg = Object.assign({ perm: 'prompt', bubble: 'grant', bubbleMs: 300, mic: 'silent', echoGain: 1 }, window.__VP__ || {})
  const t0 = performance.now()
  const log = (kind, detail) => (window.__vp = window.__vp || []).push({ t: Math.round(performance.now() - t0), kind, detail })
  window.__vpLog = log

  // --- the socket: what the server sent, what the page sent -------------------------------
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
          const chunk = m.realtimeInput.audio || (m.realtimeInput.mediaChunks || [])[0]
          if (chunk && chunk.data) {
            const bin = atob(chunk.data)
            let peak = 0
            let sumSq = 0
            let n = 0
            for (let i = 0; i + 1 < bin.length; i += 2) {
              const v = ((bin.charCodeAt(i + 1) << 8) | bin.charCodeAt(i)) << 16 >> 16
              if (Math.abs(v) > peak) peak = Math.abs(v)
              sumSq += (v / 32768) * (v / 32768)
              n += 1
            }
            window.__vpPeak = Math.max(window.__vpPeak || 0, peak)
            // Voice ONSET by the page's own rule (ADR-0026 addendum rev. 2): frame RMS >= 0.02
            // after >= 400 ms of quieter frames. Detail = assistant sources queued/sounding then.
            const rms = n ? Math.sqrt(sumSq / n) : 0
            window.__vpMaxRms = Math.max(window.__vpMaxRms || 0, rms)
            if (rms >= 0.02) {
              const nowT = performance.now()
              if (window.__vpLastLoudAt === undefined || nowT - window.__vpLastLoudAt >= 400) {
                if (!window.__vpVoiced) { window.__vpVoiced = true; log('first-voiced-frame', String(window.__vpPlaying || 0)) }
                log('voice-onset', String(window.__vpPlaying || 0))
              }
              window.__vpLastLoudAt = nowT
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

  // --- the microphone: a WebAudio graph behind a simulated bubble -------------------------
  let micCtx = null
  let micDest = null
  const echoTwins = new Map()
  const startEcho = (node, when) => {
    if (cfg.mic !== 'echo' || !micCtx || !node.buffer) return
    const twin = micCtx.createBufferSource()
    twin.__vpMic = true
    twin.buffer = node.buffer
    const gain = micCtx.createGain()
    gain.gain.value = cfg.echoGain
    twin.connect(gain)
    gain.connect(micDest)
    const delay = Math.max(0, (when || 0) - (node.context ? node.context.currentTime : 0))
    twin.start(micCtx.currentTime + delay)
    echoTwins.set(node, twin)
  }
  let speechStarted = false
  const startSpeech = async () => {
    if (cfg.mic !== 'speech' || speechStarted || !micCtx) return
    speechStarted = true
    const bin = atob(window.__VP_WAV_B64__ || '')
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const buf = await micCtx.decodeAudioData(bytes.buffer)
    const node = micCtx.createBufferSource()
    node.__vpMic = true
    node.buffer = buf
    node.connect(micDest)
    node.start()
    log('speech-started')
  }
  window.__vpTracks = []
  const micStream = async () => {
    micCtx = new AudioContext()
    micDest = micCtx.createMediaStreamDestination()
    await micCtx.resume()
    window.__vpTracks.push(...micDest.stream.getTracks())
    return micDest.stream
  }
  let permState = cfg.perm
  if (navigator.permissions && navigator.permissions.query) {
    const q = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = (d) => (d && d.name === 'microphone'
      ? Promise.resolve({ state: permState, onchange: null, addEventListener () {}, removeEventListener () {} })
      : q(d))
  }
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = (c) => {
      log('getUserMedia', JSON.stringify(c))
      if (permState === 'granted') return micStream()
      if (permState === 'denied') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      log('bubble-open')
      return new Promise((resolve, reject) => {
        if (cfg.bubble === 'never') return
        setTimeout(() => {
          if (cfg.bubble === 'deny') {
            permState = 'denied'
            log('bubble-deny')
            reject(new DOMException('Permission denied', 'NotAllowedError'))
            return
          }
          permState = 'granted'
          log('bubble-grant')
          micStream().then(resolve, reject)
        }, cfg.bubbleMs)
      })
    }
  }

  // --- what the page PLAYS ----------------------------------------------------------------
  // __vpPlaying = assistant sources started and neither stopped nor ended. The mic's own
  // sources (__vpMic) never count.
  const ABS = window.AudioBufferSourceNode
  if (ABS) {
    window.__vpPlaying = 0
    const start = ABS.prototype.start
    const stop = ABS.prototype.stop
    const off = (node) => {
      if (!node.__vpOn) return false
      node.__vpOn = false
      window.__vpPlaying -= 1
      if (window.__vpPlaying === 0) log('play-idle')
      return true
    }
    ABS.prototype.start = function (...a) {
      if (!this.__vpOn && !this.__vpMic) {
        this.__vpOn = true
        window.__vpPlaying += 1
        log('play-start')
        this.addEventListener('ended', () => { off(this) })
        startEcho(this, a[0])
        void startSpeech()
      }
      return start.apply(this, a)
    }
    ABS.prototype.stop = function (...a) {
      if (off(this)) log('play-stop')
      const twin = echoTwins.get(this)
      if (twin) { try { twin.stop() } catch (_) {} echoTwins.delete(this) }
      return stop.apply(this, a)
    }
  }

  // --- what the visitor READS: the chat status line, every change -------------------------
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('chatStatus')
    if (!el) return
    const visible = () => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
    }
    let last = null
    new MutationObserver(() => {
      const text = el.textContent || ''
      if (text === last) return
      last = text
      log('status', JSON.stringify({ text, visible: visible() }))
    }).observe(el, { childList: true, characterData: true, subtree: true })
  })

  // --- telemetry: what trackEvent hands GA, and the first-party beacon --------------------
  let realGtag = null
  const gtagProxy = (...a) => {
    if (a[0] === 'event' && /^chat_(voice|live)_/.test(String(a[1]))) {
      const p = Object.assign({}, a[2] || {})
      delete p.transport_type
      log('event', String(a[1]) + ' ' + JSON.stringify(p))
    }
    return realGtag ? realGtag(...a) : undefined
  }
  Object.defineProperty(window, 'gtag', { configurable: true, get: () => gtagProxy, set: (fn) => { realGtag = fn } })
  const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator)
  if (beacon) {
    navigator.sendBeacon = (url, data) => {
      const ok = beacon(url, data)
      if (data && typeof data.text === 'function') {
        data.text().then((t) => { if (t.includes('chat_voice_start')) log('collector-beacon', String(ok)) }).catch(() => {})
      }
      return ok
    }
  }
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

const statuses = (ev) => ev.filter((e) => e.kind === 'status').map((e) => ({ t: e.t, ...JSON.parse(e.detail) }))
const events = (ev, name) => ev.filter((e) => e.kind === 'event' && e.detail.startsWith(name + ' ')).map((e) => ({ t: e.t, params: JSON.parse(e.detail.slice(name.length + 1)) }))

// Serve the working tree under the stage origin: same-origin GETs for files that exist in
// LOCAL_ROOT are fulfilled from disk, everything else goes to the network untouched.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.txt': 'text/plain' }
async function serveLocal (page) {
  if (!LOCAL_ROOT) return
  const origin = new URL(ORIGIN).origin
  page.on('Fetch.requestPaused', ({ requestId, request }) => {
    const u = new URL(request.url)
    let path = decodeURIComponent(u.pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = join(LOCAL_ROOT, path)
    const inside = file === LOCAL_ROOT || file.startsWith(LOCAL_ROOT + sep)
    if (request.method === 'GET' && u.origin === origin && inside && existsSync(file) && statSync(file).isFile()) {
      void page.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: MIME[extname(file)] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }],
        body: readFileSync(file).toString('base64')
      }).catch(() => {})
    } else {
      void page.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
  })
  await page.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] })
}

// The hero mic opens the panel AWAITING a voice start (js/chat.js openPanelAwaitingVoiceStart);
// the session begins on the second tap, "Start voice chat" ('tap-start' marks it).
async function startVoice (page, tag) {
  await goto(page, `${ORIGIN}/?${tag}=${Date.now()}`)
  await sleep(2000)
  await evaluate(page, () => document.getElementById('heroVoiceMic').click())
  await sleep(1200)
  await evaluate(page, () => { window.__vpLog('tap-start'); document.getElementById('chatVoiceStartBtn').click() })
}

// ADR-0028 on the real Live API: mic first, greeting after the grant, the hint around the
// bubble, and the order the barge-in depends on (the mic streams before the greeting is asked).
function micFirstClaims (ev) {
  const { first } = summarise(ev)
  const tap = first('tap-start')
  const gum = first('getUserMedia')
  const setup = first('setupComplete')
  const grant = first('bubble-grant')
  const greetingAsked = first('clientContent')
  const micFrame = first('first-audio-frame')
  const greetingAudio = first('model-audio')
  const st = statuses(ev)
  const hint = st.find((s) => s.text === MIC_PERMISSION_HINT)
  const hintGone = grant && st.find((s) => s.t >= grant.t && s.text !== MIC_PERMISSION_HINT)
  const earlyGreeting = ev.find((e) => (e.kind === 'model-audio' || e.kind === 'clientContent') && grant && e.t < grant.t)
  return [
    {
      claim: 'cold path: the mic is asked at the tap, before the session is set up (parallel, not serial)',
      ok: Boolean(gum && setup && gum.t < setup.t),
      detail: `tap@${tap && tap.t} getUserMedia@${gum && gum.t} setupComplete@${setup && setup.t}`
    },
    {
      claim: `the hint shows, visible, within ${HINT_MS} ms of the tap`,
      ok: Boolean(tap && hint && hint.visible && hint.t - tap.t <= HINT_MS),
      detail: hint ? `hint@${hint.t} (${hint.t - (tap ? tap.t : 0)} ms after the tap, visible: ${hint.visible})` : `no hint; statuses: ${JSON.stringify(st.slice(0, 4))}`
    },
    {
      claim: 'no greeting is requested or heard before the grant',
      ok: Boolean(grant) && !earlyGreeting,
      detail: earlyGreeting ? `${earlyGreeting.kind}@${earlyGreeting.t} before bubble-grant@${grant.t}` : `bubble-grant@${grant && grant.t} greeting clientContent@${greetingAsked && greetingAsked.t}`
    },
    {
      claim: `the hint leaves within ${HINT_MS} ms of the grant`,
      ok: Boolean(grant && hintGone && hintGone.t - grant.t <= HINT_MS),
      detail: hintGone ? `"${hintGone.text}"@${hintGone.t} (${hintGone.t - grant.t} ms after the grant)` : 'the hint outlived the grant'
    },
    {
      // ADR-0028 §6 [qa]. Wired → greeting is pinned in node --test; the FIRST frame itself
      // waits for the worklet's first batch, a few ms after the wiring, so the claim is on audio.
      claim: 'the mic\'s first upstream frame goes out BEFORE the greeting\'s first audio arrives',
      ok: Boolean(micFrame && greetingAudio && micFrame.t < greetingAudio.t),
      detail: `greeting clientContent@${greetingAsked && greetingAsked.t} first mic frame@${micFrame && micFrame.t} first model-audio@${greetingAudio && greetingAudio.t}`
    },
    {
      claim: `the first greeting audio arrives after the grant and within ${GREETING_AFTER_GRANT_MS} ms of it`,
      ok: Boolean(grant && greetingAudio && greetingAudio.t >= grant.t && greetingAudio.t - grant.t <= GREETING_AFTER_GRANT_MS),
      detail: `bubble-grant@${grant && grant.t} first model-audio@${greetingAudio && greetingAudio.t} (${grant && greetingAudio ? greetingAudio.t - grant.t : '?'} ms)`
    }
  ]
}

// Invariant #25 on the cold path. The greeting's turnComplete is the FIRST turnComplete: an
// interrupted turn still ends with one, after its tail.
function bargeInClaims (ev) {
  const { first, firstTurn } = summarise(ev)
  const greetingAudio = first('model-audio')
  const voiced = first('first-voiced-frame')
  const cut = ev.find((e) => e.kind === 'interrupted' && firstTurn && e.t < firstTurn.t)
  const lateAudio = cut
    ? ev.filter((e) => e.kind === 'model-audio' && e.t > cut.t + GRACE_MS && e.t < firstTurn.t)
    : []
  const quietAfterVoice = voiced && ev.find((e) => e.kind === 'play-idle' && e.t >= voiced.t)
  const playingAtVoice = voiced ? Number(voiced.detail) : 0
  const serverHalfTestable = Boolean(voiced && firstTurn && voiced.t < firstTurn.t)
  const inconclusive = 'INCONCLUSIVE: the speech went out after the server\'s turnComplete - shorten the WAV\'s leading silence'
  return [
    {
      claim: 'precondition: the visitor\'s speech goes out while the greeting is PLAYING',
      ok: Boolean(voiced && greetingAudio && voiced.t > greetingAudio.t && playingAtVoice > 0),
      detail: `model-audio@${greetingAudio && greetingAudio.t} first-voiced-frame@${voiced && voiced.t} (sources playing: ${playingAtVoice}) server turnComplete@${firstTurn && firstTurn.t}`
    },
    {
      claim: `the visitor's voice silences the greeting: playback reaches zero within ${VOICE_CUT_BUDGET_MS} ms of the first voiced frame`,
      ok: Boolean(voiced && playingAtVoice > 0 && quietAfterVoice && quietAfterVoice.t - voiced.t <= VOICE_CUT_BUDGET_MS),
      detail: `first-voiced-frame@${voiced && voiced.t} play-idle@${quietAfterVoice && quietAfterVoice.t} (${quietAfterVoice && voiced ? quietAfterVoice.t - voiced.t : '?'} ms)`
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

// No SELF-cut (ADR-0026 addendum): the answer to the spoken question plays to its natural end.
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
      ? `answer play-start@${answerStart.t}, play-stop in window: ${stops.map((e) => e.t).join(', ') || 'none'}, play-idle@${ended && ended.t}`
      : 'no answer audio after the greeting and the voice'
  }
}

// P1 [qa] hint and telemetry + P2 [qa] mic first and the control: the bubble answered Allow
// after 2 s, the mic SILENT — the greeting must play to its turnComplete uncut.
async function coldGrantSilent (page) {
  const out = []
  await startVoice(page, 'voicecold')
  await sleep(22000)
  const ev = await timeline(page)
  const { first, firstTurn } = summarise(ev)
  out.push(...micFirstClaims(ev))
  const cut = ev.find((e) => e.kind === 'interrupted' && (!firstTurn || e.t < firstTurn.t))
  const stops = ev.filter((e) => e.kind === 'play-stop' && (!firstTurn || e.t < firstTurn.t))
  out.push({
    claim: 'control: with a silent mic live from the greeting\'s first frame, the greeting plays to its turnComplete uncut',
    ok: Boolean(first('model-audio') && firstTurn && !cut && stops.length === 0),
    detail: cut ? `interrupted@${cut.t}` : (stops.length ? `play-stop at ${stops.map((e) => e.t).join(', ')}` : `turnComplete@${firstTurn && firstTurn.t}`)
  })
  const start = events(ev, 'chat_voice_start')
  const grant = first('bubble-grant')
  const tap = first('tap-start')
  const okStart = start.length === 1 && start[0].params.permissionBefore === 'prompt' && start[0].params.outcome === 'granted' &&
    Math.abs(start[0].params.waitMs - GRANT_DELAY_MS) <= 400 && Object.keys(start[0].params).sort().join() === 'outcome,permissionBefore,waitMs'
  out.push({ claim: 'telemetry: ONE chat_voice_start {permissionBefore: "prompt", outcome: "granted", waitMs ≈ the bubble time}, exactly those keys', ok: okStart, detail: JSON.stringify(start) + ` (tap@${tap && tap.t} grant@${grant && grant.t})` })
  const beacon = first('collector-beacon')
  out.push({ claim: 'telemetry: the event leaves the page in the first-party beacon', ok: Boolean(beacon && beacon.detail === 'true'), detail: beacon ? `sendBeacon → ${beacon.detail} @${beacon.t}` : 'no beacon carried chat_voice_start' })
  return out
}

// P2 [qa] echo loopback — MEASURED, NOT JUDGED (ok: null prints INFO). The greeting's own audio
// is fed back into the mic at VP_ECHO_GAIN, but a WebAudio stream never passes Chrome's echo
// canceller, so this is Live's VAD against RAW echo: measured 2026-10-24 on stage, it raises
// `interrupted` ~300-500 ms into the greeting at every gain from 1 down to 0.03 (frame RMS
// 0.016), and never with gain 0. Whether the REAL AEC removes it is the owner's laptop check
// (design-notes P2 [human]); this journey keeps the raw number on record every run.
async function coldGrantEcho (page) {
  const out = []
  await startVoice(page, 'voiceecho')
  await sleep(22000)
  const ev = await timeline(page)
  const { first, firstTurn } = summarise(ev)
  const maxRms = await evaluate(page, () => window.__vpMaxRms || 0)
  out.push({ claim: `precondition: the greeting's own audio reaches the mic (loopback gain ${ECHO_GAIN}, max frame RMS ≥ 0.02)`, ok: maxRms >= 0.02 || ECHO_GAIN < 0.05, detail: `max mic frame RMS ${maxRms.toFixed(3)}` })
  const audio = first('model-audio')
  const cut = ev.find((e) => e.kind === 'interrupted' && (!firstTurn || e.t < firstTurn.t))
  out.push({
    claim: 'echo loopback with NO echo canceller (raw): does Live interrupt the greeting on its own audio?',
    ok: null,
    detail: cut ? `yes — interrupted@${cut.t}, ${audio ? cut.t - audio.t : '?'} ms after the first greeting audio` : `no — turnComplete@${firstTurn && firstTurn.t}`
  })
  return out
}

// P2 [qa] barge-in held: speech injected ~1 s into the greeting interrupts it; and the old
// navigation-while-speaking claims.
async function coldGrantSpeech (page) {
  const out = []
  await startVoice(page, 'voiceprobe')
  await sleep(30000)
  const ev = await timeline(page)
  const { first, firstTurn, said, heard } = summarise(ev)
  out.push({ claim: 'the Start tap opens a Live session (socket opens, setup completes)', ok: Boolean(first('ws-open') && first('setupComplete')), detail: '' })
  out.push({ claim: 'the model greets (audio arrives, first turn completes)', ok: Boolean(first('model-audio') && firstTurn), detail: `said: ${said.slice(0, 160)}` })
  out.push(...micFirstClaims(ev).filter((c) => /greeting audio arrives|first upstream frame/.test(c.claim)))
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

// What the visitor sees FALLBACK_MS after a moment: transcript, status, focus, Start button.
const snapshotUi = (page) => evaluate(page, () => ({
  t: Math.round(performance.now()),
  assistant: [...document.querySelectorAll('#chatMessages .chat-msg--assistant')].map((m) => m.textContent.trim()),
  status: document.getElementById('chatStatus')?.textContent || '',
  focused: document.activeElement?.id || '',
  startEnabled: Boolean(document.getElementById('chatVoiceStartBtn') && !document.getElementById('chatVoiceStartBtn').disabled),
  vpNow: (window.__vp || []).length
}))

// P2 [qa] deny: no greeting audio, text fallback visible within 1 s, socket closed.
async function coldDeny (page) {
  const out = []
  await startVoice(page, 'voicedeny')
  // The bubble is denied GRANT_DELAY_MS after the tap; look FALLBACK_MS after that.
  await sleep(GRANT_DELAY_MS + FALLBACK_MS)
  const ui = await snapshotUi(page)
  await sleep(4000)
  const ev = await timeline(page)
  const { first } = summarise(ev)
  const deny = first('bubble-deny')
  const opened = first('ws-open-attempt')
  const closed = first('ws-close')
  out.push({ claim: 'deny: no greeting is requested and no greeting audio ever arrives', ok: Boolean(deny) && !first('model-audio') && !first('clientContent'), detail: `bubble-deny@${deny && deny.t}` })
  out.push({ claim: 'deny: the Live session is closed (no open socket left)', ok: !opened || Boolean(closed), detail: opened ? `ws-open-attempt@${opened.t} ws-close@${closed && closed.t}` : 'no socket opened' })
  out.push({
    claim: `deny: within ${FALLBACK_MS} ms the text fallback shows — the greeting in the transcript, the denied copy, the composer focused`,
    ok: ui.assistant.includes(GREETING_COLD) && ui.status === DENIED_COPY && ui.focused === 'chatComposerInput',
    detail: JSON.stringify(ui)
  })
  const start = events(ev, 'chat_voice_start')
  out.push({ claim: 'deny: telemetry outcome "denied"', ok: start.length === 1 && start[0].params.outcome === 'denied', detail: JSON.stringify(start) })
  return out
}

// P2 [qa] ignore: the bubble is never answered; the session closes at the permission timeout.
async function coldIgnored (page) {
  const out = []
  await startVoice(page, 'voiceignore')
  await sleep(PERMISSION_WAIT_MS + 3000)
  const ui = await snapshotUi(page)
  const ev = await timeline(page)
  const { first } = summarise(ev)
  const tap = first('tap-start')
  const closed = first('ws-close')
  const waited = closed && tap ? closed.t - tap.t : null
  out.push({ claim: 'ignore: no greeting is requested and no greeting audio ever arrives', ok: !first('model-audio') && !first('clientContent'), detail: '' })
  out.push({
    claim: `ignore: the session closes at the permission timeout (${PERMISSION_WAIT_MS} ms after the tap, +1.5 s)`,
    ok: waited !== null && waited >= PERMISSION_WAIT_MS && waited <= PERMISSION_WAIT_MS + 1500,
    detail: `tap@${tap && tap.t} ws-close@${closed && closed.t} (${waited} ms)`
  })
  out.push({ claim: 'ignore: the panel says "no access yet" and Start voice chat is enabled', ok: ui.status === MIC_DISMISSED_MSG && ui.startEnabled, detail: JSON.stringify(ui) })
  const start = events(ev, 'chat_voice_start')
  out.push({ claim: 'ignore: telemetry outcome "timeout"', ok: start.length === 1 && start[0].params.outcome === 'timeout', detail: JSON.stringify(start) })
  return out
}

// P2 [qa] hang up 1 s into the wait; the bubble is then answered Allow (3 s after the tap).
async function coldHangUp (page) {
  const out = []
  await startVoice(page, 'voicehangup')
  await sleep(1000)
  await evaluate(page, () => { window.__vpLog('hang-up'); document.getElementById('chatVoiceMic').click() })
  await sleep(500)
  const atHangUp = await timeline(page)
  await sleep(6000)
  const ev = await timeline(page)
  const { first } = summarise(ev)
  const hangUp = first('hang-up')
  const closed = atHangUp.find((e) => e.kind === 'ws-close' && e.t >= hangUp.t)
  const opened = atHangUp.find((e) => e.kind === 'ws-open-attempt')
  const grant = first('bubble-grant')
  const tracks = await evaluate(page, () => (window.__vpTracks || []).map((t) => t.readyState))
  const errors = statuses(ev).filter((s) => s.t > hangUp.t && /denied|failed|could not|error/i.test(s.text))
  out.push({ claim: 'hang-up: no greeting is requested and no greeting audio arrives, before or after', ok: !first('model-audio') && !first('clientContent'), detail: '' })
  out.push({ claim: 'hang-up: the Live session closes at once (within 500 ms)', ok: !opened || Boolean(closed), detail: `hang-up@${hangUp && hangUp.t} ws-open-attempt@${opened && opened.t} ws-close@${closed && closed.t}` })
  out.push({ claim: 'hang-up: the Allow that comes after it leaves the mic OFF (its track ended)', ok: Boolean(grant) && tracks.length > 0 && tracks.every((s) => s === 'ended'), detail: `bubble-grant@${grant && grant.t} tracks: ${JSON.stringify(tracks)}` })
  out.push({ claim: 'hang-up: no error copy', ok: errors.length === 0, detail: JSON.stringify(errors) })
  const start = events(ev, 'chat_voice_start')
  out.push({ claim: 'hang-up: telemetry outcome "hangup"', ok: start.length === 1 && start[0].params.outcome === 'hangup', detail: JSON.stringify(start) })
  return out
}

// P1 [qa] pre-granted: the hint never appears (every status change is observed), wait 0.
async function warmStart (page) {
  const out = []
  await startVoice(page, 'voicewarm')
  await sleep(15000)
  const ev = await timeline(page)
  const { first } = summarise(ev)
  const hint = statuses(ev).find((s) => s.text === MIC_PERMISSION_HINT)
  out.push({ claim: 'warm: the greeting plays', ok: Boolean(first('model-audio')), detail: '' })
  out.push({ claim: 'warm: the hint never appears', ok: !hint, detail: hint ? `hint@${hint.t}` : `statuses: ${statuses(ev).map((s) => s.text).join(' | ')}` })
  const start = events(ev, 'chat_voice_start')
  out.push({
    claim: 'warm: telemetry {permissionBefore: "granted", outcome: "granted", waitMs: 0}',
    ok: start.length === 1 && start[0].params.permissionBefore === 'granted' && start[0].params.outcome === 'granted' && start[0].params.waitMs === 0,
    detail: JSON.stringify(start)
  })
  return out
}

// A chip tapped WHILE THE GREETING PLAYS (silent mic, so only the chip can cut it): playback
// stops locally at once, nothing more of the greeting plays, and the chip's reply is heard.
// The project card is opened BEFORE voice starts and the tap happens in-page on the greeting's
// first play-start, polled every 10 ms. A greeting the server finished before the tap makes the
// residual claim INCONCLUSIVE (a FAIL): a pass there would prove nothing about the gate.
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
  // The reply can take ~17 s to finish (backlog F4): wait for it.
  await sleep(24000)
  const all = await timeline(page)
  const first = taps[0]
  const last = taps[taps.length - 1]
  const tapT = (tap) => (all[tap.at - 1] ? all[tap.at - 1].t : 0)
  const greetingDone = all.slice(0, first.at).some((e) => e.kind === 'turnComplete')
  const afterFirst = all.slice(first.at)
  const abandonedEnd = greetingDone ? null : afterFirst.find((e) => e.kind === 'turnComplete')
  const greetingTail = abandonedEnd ? afterFirst.filter((e) => e.kind === 'play-start' && e.t < abandonedEnd.t) : []
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

// A chip tapped DURING a live voice call reaches the model and leaves the call alive.
async function voiceChip (page) {
  const out = []
  await startVoice(page, 'voicechip')
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
  const closed = ev.find((e) => e.kind === 'ws-close')
  const sentChip = ev.find((e) => e.kind === 'clientContent' && /summari[sz]e/i.test(e.detail || ''))
  out.push({ claim: "the chip's prompt is put to the model over the live call", ok: Boolean(sentChip), detail: sentChip ? sentChip.detail : 'no clientContent with the prompt' })
  out.push({ claim: 'the call survives the chip tap (no socket close)', ok: !closed, detail: closed ? closed.detail : '' })
  out.push({ claim: 'the answer comes back by VOICE, about that project', ok: /apptio|ibm|spark|pipeline|financial/i.test(said), detail: `voice said: ${said.slice(0, 160)}` })
  return out
}

async function main () {
  if (!findChrome()) { console.error('No Chrome found - skipping is not a pass.'); process.exit(2) }
  const results = []
  const cold = (extra) => ({ perm: 'prompt', bubble: 'grant', bubbleMs: GRANT_DELAY_MS, ...extra })
  const journeys = [
    ['cold grant after 2 s, silent mic: mic first, then an uncut greeting', coldGrantSilent, cold({ mic: 'silent' })],
    ['cold grant after 2 s, echo loopback with no echo canceller (measured)', coldGrantEcho, cold({ mic: 'echo', echoGain: ECHO_GAIN })],
    ['cold grant after 2 s, speech 1 s into the greeting: barge-in, navigation while speaking', coldGrantSpeech, cold({ mic: 'speech' })],
    ['cold deny: text fallback, no greeting audio', coldDeny, cold({ bubble: 'deny' })],
    ['cold ignore: the permission timeout closes the session', coldIgnored, cold({ bubble: 'never' })],
    ['cold hang-up 1 s into the wait', coldHangUp, cold({ bubbleMs: 3000 })],
    ['warm (already granted): no hint, wait 0', warmStart, { perm: 'granted', mic: 'silent' }],
    ['chip mid-greeting: local stop, reply heard', chipMidGreeting, cold({ bubbleMs: 300, mic: 'silent' })],
    ['two quick chips mid-greeting: the last reply is not swallowed', twoChipsMidGreeting, cold({ bubbleMs: 300, mic: 'silent' })],
    ['voice chips', voiceChip, cold({ bubbleMs: 300, mic: 'silent' })]
  ]
  for (const [name, journey, cfg] of journeys) {
    if (process.env.VP_ONLY && !name.includes(process.env.VP_ONLY)) continue
    const page = await launch({ width: 1280, height: 900, chromeArgs: ['--autoplay-policy=no-user-gesture-required'] })
    await page.send('Page.enable')
    await serveLocal(page)
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__VP__ = ${JSON.stringify(cfg)}; window.__VP_WAV_B64__ = ${JSON.stringify(cfg.mic === 'speech' ? WAV_B64 : '')}` })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    try {
      for (const r of await journey(page)) results.push({ journey: name, ...r })
      if (process.env.VP_DUMP) console.log(name, JSON.stringify((await timeline(page)).filter((e) => !['model-audio', 'play-start', 'said', 'heard'].includes(e.kind)).map((e) => `${e.t}:${e.kind}${e.detail ? '=' + String(e.detail).slice(0, 90) : ''}`)))
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
    // ok === null: a measurement kept on record, not a judged claim (the echo loopback).
    if (r.ok === false) failed++
    console.log(`  ${r.ok === null ? 'INFO' : (r.ok ? 'ok  ' : 'FAIL')} ${r.claim}${r.detail ? `\n       ${r.detail}` : ''}`)
  }
  const judged = results.filter((r) => r.ok !== null).length
  console.log(`\n${judged - failed}/${judged} claims held on ${ORIGIN}${LOCAL_ROOT ? ` (page files from ${LOCAL_ROOT})` : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
