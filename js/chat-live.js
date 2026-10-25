/**
 * Gemini Live (browser WebSocket): mic capture + PCM playback + transcript bubbles.
 */

import { trackEvent } from './analytics.js'
import { chatBus } from './chat-bus.js'
import { chatApiUrl } from './site-config.js'
import { shouldRevealResumeButton } from './voice-resume-button.js'
import { hasNavPromiseGap } from './nav-promise-gap.js'
import { freshTurnGate, nextTurnGate, acceptsTurnOutput, isIdleGate } from './voice-turn-gate.js'
import { subscribe as subscribeSiteState, getSiteStateForWire, siteStateWireIfNotable } from './site-state.js'
import { createSiteStateNotifier } from './site-state-notes.js'

const INPUT_RATE = 16000

/** Hard cap on queued PCM chunks. At ~1s/chunk (Gemini Live's typical output
 *  cadence) this is ~17 minutes of buffer — well above any single turn, well
 *  below memory pressure. When hit, the player drops NEW chunks via
 *  backpressure (see PcmJitterPlayer.enqueue). The old behavior flushed the
 *  *queue* mid-reply, which audibly cut the agent off ("…and then we…" stops,
 *  next chunk starts a new sentence) — strictly worse than dropping incoming.
 *  Real barge-in goes through interruptAssistant() → interrupt() (ADR-0026 §3). */
const PCM_JITTER_MAX_QUEUED_CHUNKS = 1024
/** Close voice if the WebSocket sends nothing for this long (ms). */
const VOICE_WS_IDLE_MS = 3 * 60 * 1000
/** Close an open-but-mic-less voice session after this idle stretch (ms).
 *  When the visitor lands in the chooser and the greeting plays, the live
 *  session is open without a mic attached. If they don't engage in time, we
 *  close it silently — re-opening on a later tap mints a fresh token in <1 s. */
const VOICE_SESSION_IDLE_NO_MIC_MS = 60 * 1000
/** After the warm greeting finishes, wait this long for user audio before
 *  prompting the model to continue with what the visitor can ask. */
const VOICE_WARM_FOLLOWUP_MS = 7 * 1000
/** Local voice onset (ADR-0026 addendum): a mic frame at or above this RMS (float samples,
 *  full scale 1.0; 0.02 ≈ -34 dBFS) after at least VOICE_ONSET_SILENCE_MS of quieter frames.
 *  getUserMedia runs with echoCancellation + noiseSuppression, so room noise and most of the
 *  assistant's own playback sit well below it, while normal speech runs ~0.03-0.2. A transcript
 *  fragment must still confirm the onset before anything is cut. */
const VOICE_ONSET_RMS = 0.02
const VOICE_ONSET_SILENCE_MS = 400
/** Hard cap on continuous voice session length (ms). */
const VOICE_MAX_SESSION_MS = 25 * 60 * 1000
/** Per-attempt POST /api/live/session budget (ms). Sized > backend mint timeout
 *  (GEMINI_LIVE_MINT_TIMEOUT_SEC, default 50) so the FE always sees the real
 *  504 instead of aborting on its own and forcing a blind retry. */
const LIVE_SESSION_ATTEMPT_MS = 60 * 1000
/** Retries after the first POST attempt (inclusive budget ≈ 4 × 45s + backoff). */
const LIVE_SESSION_MAX_RETRIES = 3
const LIVE_SESSION_RETRY_BACKOFF_MS = [600, 1400, 2800]
/** Full connect rounds (new session POST + WebSocket) on transient WS/setup failure. */
const VOICE_CONNECT_MAX_ROUNDS = 2
const VOICE_CONNECT_ROUND_BACKOFF_MS = [800, 1600]
/** WebSocket must reach OPEN before setup wait (ms). */
const LIVE_WS_OPEN_MS = 20 * 1000
/** Max wait for setupComplete after WebSocket is open (ms). */
const LIVE_SETUP_WAIT_MS = 60 * 1000

/** Greeting text + the model instruction wrapper. We tell the model to speak
 *  only the verbatim sentence (no preamble, no commentary) so the visitor
 *  hears exactly the prompt the product team approved. */
const GREETING_TEXT_COLD = "Hi! I'm Marwan's AI assistant. What would you like to know about his work?"
const GREETING_TEXT_WARM = "Hi! I'm Marwan's AI assistant — what would you like to know?"
const WARM_FOLLOWUP_INSTRUCTION = (
  'The visitor has not spoken yet. Continue naturally in one short sentence — '
  + "invite them to ask about Marwan's work, projects, or experience. Under 18 words."
)
const greetingInstruction = (verbatim) => (
  `Speak only these exact words and then stop. Do not add any preamble or trailing remark. Say: "${verbatim}"`
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const makeVoiceRetryableError = (message) => {
  const err = new Error(message)
  err.retryable = true
  return err
}

const isVoiceRetryableHttpStatus = (status) =>
  status === 408 || status === 429 || status === 502 || status === 503 || status === 504

const isVoiceRetryableError = (error) =>
  Boolean(error && typeof error === 'object' && error.retryable)

const isVoiceRetryableSetupFailure = (error, isRelayWsPath) => {
  if (!error || typeof error !== 'object') return false
  if (error.retryable) return true
  if (error.name !== 'LiveSetupFailed') return false
  return Boolean(isRelayWsPath)
}

async function postLiveVoiceSession(postUrl, sessionId, { onRetry } = {}) {
  let lastError = null
  const maxAttempts = LIVE_SESSION_MAX_RETRIES + 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // siteState rides along on the mint (ADR-0015 ss6). The voice path needs it MORE than
    // the text path: a live session is minted once and then talks for minutes, so the
    // system instruction is the only chance to tell it where the visitor already is. ss7
    // keeps it current from there. Omitted when there is nothing worth saying - the server
    // then leaves the line out rather than asserting the default.
    const site = siteStateWireIfNotable()
    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(site ? { sessionId, siteState: site } : { sessionId })
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      fetchOpts.signal = AbortSignal.timeout(LIVE_SESSION_ATTEMPT_MS)
    }
    try {
      let response
      try {
        response = await fetch(postUrl, fetchOpts)
      } catch (fetchErr) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw makeVoiceRetryableError('You appear to be offline. Check your connection and try again.')
        }
        if (fetchErr instanceof Error
          && (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError')) {
          throw makeVoiceRetryableError('Voice session request timed out.')
        }
        throw makeVoiceRetryableError('Could not reach the voice service. Check your connection and try again.')
      }

      const responseText = await response.text()
      let body = {}
      if (responseText) {
        try {
          body = JSON.parse(responseText)
        } catch (_) {
          body = {}
        }
      }

      if (!response.ok) {
        const detail = body?.detail || body?.error
        const code = body?.code
        const msg = typeof detail === 'string' && detail.trim()
          ? detail.trim()
          : 'Could not start voice session.'
        if (isVoiceRetryableHttpStatus(response.status)
          || code === 'live_mint_timeout'
          || code === 'upstream_timeout') {
          throw makeVoiceRetryableError(msg)
        }
        throw new Error(msg)
      }

      const { websocketUrl, handshake, model: modelFromBody } = body
      if (!websocketUrl || !handshake) {
        throw makeVoiceRetryableError('Voice session response was incomplete.')
      }
      return body
    } catch (error) {
      lastError = error
      if (!isVoiceRetryableError(error) || attempt >= LIVE_SESSION_MAX_RETRIES) {
        throw error
      }
      if (typeof onRetry === 'function') {
        onRetry(attempt + 1, maxAttempts)
      }
      await sleep(LIVE_SESSION_RETRY_BACKOFF_MS[attempt] || 2800)
    }
  }
  throw lastError || makeVoiceRetryableError('Could not start voice session.')
}

function detachWebSocketHandlers(socket) {
  if (!socket) return
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
}

/** Inline AudioWorklet (addModule via blob URL) — avoids deprecated ScriptProcessorNode when supported. */
const MIC_CAPTURE_WORKLET_SOURCE = `
class GvpMicPcmSenderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0]
    if (!ch0 || !ch0.length) return true
    const copy = new Float32Array(ch0.length)
    copy.set(ch0)
    this.port.postMessage(copy, [copy.buffer])
    return true
  }
}
registerProcessor('gvp-mic-pcm-sender', GvpMicPcmSenderProcessor)
`


async function decodeWebSocketJsonPayload(raw) {
  let text = ''
  if (typeof raw === 'string') {
    text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  } else if (raw instanceof Blob) {
    text = await raw.text()
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder('utf-8').decode(raw)
  } else if (raw && typeof raw.arrayBuffer === 'function') {
    const ab = await raw.arrayBuffer()
    text = new TextDecoder('utf-8').decode(ab)
  }
  return text
}

function voiceRelayCloseUserMessage(code, reason) {
  const r = (reason || '').trim()
  if (code === 4403) {
    return 'Voice blocked: this page origin is not allowed on the chat API (check CHAT_CORS_ORIGINS).'
  }
  if (code === 4404) {
    return r
      ? `Voice relay expired (${r}). Tap Start voice chat again.`
      : 'Voice relay link expired. Tap Start voice chat to begin a new session.'
  }
  return voiceSessionEarlyCloseUserMessage(code, reason)
}

function voiceSessionEarlyCloseUserMessage(code, reason) {
  const r = (reason || '').trim()
  if (r) return `Voice session ended before it was ready (${r}). Try again.`
  if (code === 1006) {
    return 'Voice session dropped (network). Check your connection and try again.'
  }
  if (code === 1008 || code === 1011) {
    return 'Voice session was rejected by the service. Try again in a moment.'
  }
  if (code && code !== 1000) {
    return `Voice session ended before it was ready (code ${code}). Try again.`
  }
  return 'Voice session ended before it was ready. Try again or check your connection.'
}

function liveSetupTimeoutMessage(isRelayWsPath) {
  if (isRelayWsPath) {
    return 'Voice did not become ready in time. Confirm the latest chat image is deployed and CHAT_CORS_ORIGINS includes this site.'
  }
  return 'Voice did not become ready in time. Check your connection and try again.'
}

/** Shown when direct browser→Google live voice fails on serverless chat (no WS relay). */
const VOICE_UNAVAILABLE_ON_HOST_MSG = (
  'Voice is not available on this chat endpoint. Use text, or enable WebSockets on the chat API for voice.'
)

/** Dev-only: set localStorage gvp_chat_voice_allow_direct=1 to attempt Live over direct_google (often fails with 1011). */
function voiceAllowDirectGoogleDevOverride() {
  try {
    return typeof localStorage !== 'undefined'
      && localStorage.getItem('gvp_chat_voice_allow_direct') === '1'
  } catch (_) {
    return false
  }
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function resolveChatApiBase() {
  const raw = chatApiUrl || ''
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed.endsWith('/api/chat')) return trimmed.slice(0, -'/api/chat'.length)
  const stripped = trimmed.replace(/\/api\/chat\/?$/i, '')
  if (stripped.startsWith('http://') || stripped.startsWith('https://')) return stripped
  if (stripped.startsWith('/')) return stripped
  return stripped || ''
}

function extractErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return 'Voice chat failed. Please try again.'
}

function voiceCaptureGateMessage() {
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return 'Voice needs a secure page (HTTPS). Use the https:// URL or localhost.'
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return 'This browser does not support microphone capture for voice chat.'
  }
  // HTTPS page + http:// chat API = browser silently blocks the POST and the
  // ws:// upgrade as active mixed content, which surfaces as a 45-60s "voice
  // timed out" with no clue in the console. Fail loud, fail fast instead.
  if (typeof window.location !== 'undefined' && window.location.protocol === 'https:') {
    const apiBase = resolveChatApiBase()
    if (typeof apiBase === 'string' && /^http:\/\//i.test(apiBase)) {
      return 'Voice needs the chat API on HTTPS too (browsers block ws:// + http:// from https:// pages). Add an ACM cert to the ALB / front it with CloudFront.'
    }
  }
  return ''
}

/** ADR-0028 §3.1 — shown only while the cold path's mic request is pending. Owner copy. */
const MIC_PERMISSION_HINT =
  'Your browser is asking for the microphone — choose “Allow while visiting the site” so we don\'t ask again.'

/** How long the cold path waits on the permission bubble before closing the Live session
 *  (ADR-0028 addendum, N-P2). Its own number: the no-mic sweep is a different window. */
const VOICE_PERMISSION_WAIT_MS = 20 * 1000

/** A dismissed bubble — and, by the same "no answer yet", the permission-wait timeout. */
const MIC_DISMISSED_MSG =
  'No microphone access yet — tap Start voice chat to be asked again.'

/** The one getUserMedia request, identical on every call (a changing constraint must never be
 *  why a browser asks again — design-notes P1). Frozen so nothing can drift it at runtime. */
const MIC_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1
  }),
  video: false
})

function releaseStream(acquired) {
  try { acquired?.getTracks().forEach((t) => t.stop()) } catch (_) {}
}

function micAccessUserMessage(error) {
  const name = error && typeof error === 'object' ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow the mic for this site in your browser settings.'
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found. Connect a mic or pick an input device, then try again.'
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'OverconstrainedError') {
    return 'The microphone is busy or unavailable. Close other apps using the mic and try again.'
  }
  return extractErrorMessage(error)
}

function downsampleFloat32(input, inputRate, outRate) {
  if (inputRate === outRate) return input
  const ratio = inputRate / outRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.floor(i * ratio)]
  }
  return out
}

function floatTo16BitPCM(float32) {
  const buf = new ArrayBuffer(float32.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buf)
}

function base64FromBytes(bytes) {
  let binary = ''
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i])
  return btoa(binary)
}

function decodePcmBase64(b64, mimeType) {
  const rateMatch = /rate=(\d+)/i.exec(mimeType || '')
  const rate = rateMatch ? Number(rateMatch[1]) : 24000
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  const dv = new DataView(buf)
  const len = Math.floor(bin.length / 2)
  const floats = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    floats[i] = dv.getInt16(i * 2, true) / 32768
  }
  return { floats, rate }
}

function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate) return input
  const outLen = Math.max(1, Math.round(input.length * outRate / inRate))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * inRate / outRate
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const f = pos - i0
    out[i] = input[i0] * (1 - f) + input[i1] * f
  }
  return out
}

function appendChatBubble(messagesEl, role, text, streaming) {
  const item = document.createElement('li')
  item.className = `chat-msg chat-msg--${role}`
  if (streaming) item.classList.add('chat-msg--streaming')

  const bubble = document.createElement('div')
  bubble.className = 'chat-msg__bubble'
  const body = document.createElement('p')
  body.className = 'chat-msg__text'
  body.textContent = text || ''
  bubble.appendChild(body)

  if (streaming) {
    const cursor = document.createElement('span')
    cursor.className = 'chat-msg__cursor'
    cursor.setAttribute('aria-hidden', 'true')
    bubble.appendChild(cursor)
  }

  item.appendChild(bubble)
  messagesEl.appendChild(item)
  return item
}

function finalizeBubble(el, text) {
  const textEl = el.querySelector('.chat-msg__text')
  if (textEl) textEl.textContent = text || ''
  el.classList.remove('chat-msg--streaming')
  el.querySelector('.chat-msg__cursor')?.remove()
}

/** Cheap RMS over a Float32 PCM frame; used for the speaking-aura and the
 *  mic-input aura. Returning 0 for empty input keeps the callback contract
 *  predictable (consumers can read the level as "speech amplitude in [0,1]"). */
function pcmFrameRms(floats) {
  if (!floats || !floats.length) return 0
  let sum = 0
  for (let i = 0; i < floats.length; i++) {
    const v = floats[i]
    sum += v * v
  }
  return Math.sqrt(sum / floats.length)
}

class PcmJitterPlayer {
  /** onLevel?: (rms in [0,1]) => void — invoked per chunk (model speaking) and
   *  with 0 when playback drains/interrupts (drives the speaking-aura). */
  constructor({ onLevel } = {}) {
    this.ctx = null
    this.sources = []
    this.scheduledEnd = 0
    this.onLevel = typeof onLevel === 'function' ? onLevel : null
    // Bumped by interrupt(). enqueue is async (it awaits ensure/resume), so a chunk the gate
    // accepted just before an interrupt could otherwise resume after it and start a source on
    // the cleared queue (ADR-0026 §3.3).
    this.epoch = 0
  }

  async ensure(sampleRate) {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ sampleRate })
      } catch (_) {
        this.ctx = new AudioContext()
      }
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    return this.ctx
  }

  interrupt() {
    this.epoch += 1
    for (const s of this.sources) {
      try {
        s.stop()
      } catch (_) {}
    }
    this.sources = []
    if (this.ctx) this.scheduledEnd = this.ctx.currentTime
    this.onLevel?.(0)
  }

  async enqueue(floats, sampleRate) {
    const epoch = this.epoch
    const ctx = await this.ensure(sampleRate)
    if (epoch !== this.epoch) return
    const sr = ctx.sampleRate
    const now = ctx.currentTime
    if (this.sources.length >= PCM_JITTER_MAX_QUEUED_CHUNKS) {
      // Backpressure: drop incoming chunks instead of flushing what's already
      // playing. Listener still hears the in-flight sentence finish; we just
      // stop chasing a runaway producer. The hard cap is generous enough that
      // hitting it = the model is misbehaving, not normal speech.
      return
    }
    const adjusted = sampleRate === sr ? floats : resampleLinear(floats, sampleRate, sr)
    this.onLevel?.(pcmFrameRms(adjusted))
    const buffer = ctx.createBuffer(1, adjusted.length, sr)
    buffer.copyToChannel(adjusted, 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const startAt = Math.max(this.scheduledEnd, now + 0.02)
    src.start(startAt)
    this.sources.push(src)
    src.onended = () => {
      const i = this.sources.indexOf(src)
      if (i >= 0) this.sources.splice(i, 1)
      if (this.sources.length === 0) this.onLevel?.(0)
    }
    this.scheduledEnd = startAt + buffer.duration
  }

  /** True while any chunk is queued or sounding. */
  isPlaying() {
    return this.sources.length > 0
  }

  close() {
    this.interrupt()
    if (this.ctx) this.ctx.close().catch(() => {})
    this.ctx = null
  }
}

/** Best-effort mic permission state — 'granted' | 'denied' | 'prompt' | 'unknown'.
 *  'granted' picks the warm path (open → greet → mic, ADR-0026 §2); everything else asks
 *  for the mic first and greets only after the grant (ADR-0028). */
async function detectMicPermissionState() {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions || typeof navigator.permissions.query !== 'function') {
      return 'unknown'
    }
    const status = await navigator.permissions.query({ name: 'microphone' })
    return status && typeof status.state === 'string' ? status.state : 'unknown'
  } catch (_) {
    return 'unknown'
  }
}

function normalizeMicButtons(opts) {
  if (Array.isArray(opts.micButtons) && opts.micButtons.length) {
    return opts.micButtons.filter(Boolean)
  }
  return opts.micButton ? [opts.micButton] : []
}

export function bindChatLiveVoice(opts) {
  const {
    messagesEl,
    statusEl,
    syncEmptyState,
    scrollMessagesToBottom,
    setStatus,
    getSessionId,
    isTextPending,
    openPanel,
    isPanelOpen,
    patchLiveUi,
    onToolCall,
    /** Optional level callback: ({ input, output }) every audio frame.
     *  Both are RMS in [0,1]. Phase 3b's aura subscribes to drive CSS vars. */
    onAudioLevels,
    /** When true, mic launcher opens the Start gate instead of connecting voice. */
    onVoiceLauncherRequest,
    /** Optional: move focus to the text composer (the denied → text fallback, ADR-0028). */
    focusComposer
  } = opts

  const emitLevel = typeof onAudioLevels === 'function'
    ? (which, rms) => {
        try { onAudioLevels({ source: which, level: rms }) } catch (_) {}
      }
    : null

  const micButtons = normalizeMicButtons(opts)
  if (!micButtons.length || !messagesEl) return () => {}
  if (typeof patchLiveUi !== 'function') return () => {}
  if (micButtons.some((b) => b.dataset.gvpChatLiveVoice === '1')) return () => {}
  micButtons.forEach((b) => {
    b.dataset.gvpChatLiveVoice = '1'
  })

  let ws = null
  let stream = null
  let audioCtx = null
  let processor = null
  let mediaSource = null
  let player = null
  let setupDone = false
  let active = false
  /** True after POST /api/live/session succeeds; ensures ws.onclose cleans partial setup. */
  let voiceSessionOpen = false

  // ADR-0015 ss7: while the visitor is talking, the site keeps changing under the
  // conversation. The session was minted with one snapshot of where they were, and without
  // this it stays frozen at that snapshot for the whole call.
  //
  // Everything that touches the outside is injected, so the notifier itself has no way to
  // end a session (invariant #20) - it is given a send and nothing else. voiceActive comes
  // from `voiceSessionOpen` rather than the store so the gate is the socket's real state,
  // not a flag something else might have written.
  const siteStateNotifier = createSiteStateNotifier({
    getWireState: () => (voiceSessionOpen ? { ...getSiteStateForWire(), voiceActive: true } : null),
    isSessionOpen: () => voiceSessionOpen && ws != null && ws.readyState === WebSocket.OPEN,
    send: (payload) => { ws.send(JSON.stringify(payload)) },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id)
  })
  const unsubscribeSiteState = subscribeSiteState((_snapshot, change) => {
    if (change) siteStateNotifier.onChange(change)
  })
  /** True while startVoice is past UI gates (blocks overlapping starts that orphan the WebSocket). */
  let voiceConnectInFlight = false
  /** Last POST /api/live/session `liveVoiceTransport` for close-message context. */
  let lastLiveVoiceTransport = null
  /** After relay + 1011/internal early close, block retries (host may not support WS relay). */
  let voiceUnavailableOnHost = false
  let voiceWsIdleTimer = null
  let voiceMaxSessionTimer = null
  /** Resolves when Live setupComplete arrives; cleared after await or on stop. */
  let pendingSetupLatch = null
  /** Rejects the in-flight "socket opened" wait (set only while the socket is CONNECTING). */
  let pendingWsOpenFail = null
  let wsOpened = false

  const rejectPendingSetupLatch = (err) => {
    if (!pendingSetupLatch) return false
    if (pendingSetupLatch.timeoutId != null) clearTimeout(pendingSetupLatch.timeoutId)
    const rj = pendingSetupLatch.reject
    pendingSetupLatch = null
    if (typeof rj === 'function') {
      try {
        rj(err)
      } catch (_) {}
      return true
    }
    return false
  }

  const clearVoiceTimers = () => {
    if (voiceWsIdleTimer) {
      clearTimeout(voiceWsIdleTimer)
      voiceWsIdleTimer = null
    }
    if (voiceMaxSessionTimer) {
      clearTimeout(voiceMaxSessionTimer)
      voiceMaxSessionTimer = null
    }
  }

  const bumpVoiceWsIdleTimer = () => {
    if (!voiceSessionOpen || !ws) return
    if (voiceWsIdleTimer) clearTimeout(voiceWsIdleTimer)
    voiceWsIdleTimer = setTimeout(() => {
      voiceWsIdleTimer = null
      if (!voiceSessionOpen) return
      setStatus('Voice closed after a long quiet period. Tap Start voice chat to try again.', 'error')
      trackEvent('chat_live_stop', { reason: 'ws_idle' })
      stopVoiceInternal({ silent: false })
    }, VOICE_WS_IDLE_MS)
  }

  let userBubble = null
  let assistantBubble = null
  let userDraft = ''
  let assistantDraft = ''
  let turnToolCalls = []
  /** Per-turn telemetry — drains into persistVoiceTurn so the admin dashboard
   *  can show audio bytes / duration / interrupt-rate without reconstructing
   *  from server logs. Reset in resetDraftState alongside the text drafts. */
  let turnStartedAt = 0
  let turnAudioInBytes = 0
  let turnAudioOutBytes = 0
  let turnInterrupted = false
  let turnGate = freshTurnGate()
  const markTurnStart = () => {
    if (!turnStartedAt) turnStartedAt = Date.now()
  }

  /** Voice intent for the current session: the permission state at start ('warm' = already
   *  granted; 'cold' = not, and it stays 'cold' after a cold grant — ADR-0028 §3.4). Picks
   *  the greeting text and whether the warm follow-up nudge fires after a silent greeting. */
  let sessionIntent = 'cold'
  let greetingTurnComplete = false
  let userSpokeAfterGreeting = false
  /** True once this conversation has been greeted. Subsequent voice sessions
   *  in the SAME conversation skip the greeting and go straight to
   *  listening — re-hearing "Hi, I'm your AI Assistant" every time the
   *  visitor pauses and restarts voice is grating. chat.js calls resetGreet()
   *  from resetConversation() so Start Over re-arms the greeting. */
  let conversationGreeted = false
  /** Closes a session that opened but never had its mic attached. */
  let noMicIdleTimer = null
  /** Bumped by every stop that ends a start (ADR-0028 §3.2 stale-start guard): an await in
   *  startVoice that comes back to a different epoch belongs to a call the visitor ended. */
  let startEpoch = 0
  /** The cold path's wait on the bubble (ADR-0028 §3.2): its timeout, and how a stop ends it. */
  let permissionWaitTimer = null
  let permissionWaitAbort = null
  /** The current start's mic question, settled ONCE into one `chat_voice_start` (ADR-0028
   *  addendum §3): { permissionBefore, requestedAt } — requestedAt null when no bubble could
   *  be shown (warm), so the wait reads 0. */
  let voiceStartRecord = null
  /** The permission state read at the current start (telemetry's `permissionBefore`). */
  let startPermission = 'unknown'
  const settleVoiceStart = (outcome) => {
    const rec = voiceStartRecord
    if (!rec) return
    voiceStartRecord = null
    trackEvent('chat_voice_start', {
      permissionBefore: rec.permissionBefore,
      outcome,
      waitMs: rec.requestedAt == null ? 0 : Math.max(0, Date.now() - rec.requestedAt)
    })
  }
  const clearPermissionWait = () => {
    if (permissionWaitTimer) clearTimeout(permissionWaitTimer)
    permissionWaitTimer = null
    permissionWaitAbort = null
  }
  /** Fires the "tell them what they can ask" follow-up on warm sessions. */
  let warmFollowupTimer = null

  const clearNoMicIdleTimer = () => {
    if (!noMicIdleTimer) return
    clearTimeout(noMicIdleTimer)
    noMicIdleTimer = null
  }

  const clearWarmFollowupTimer = () => {
    if (!warmFollowupTimer) return
    clearTimeout(warmFollowupTimer)
    warmFollowupTimer = null
  }

  const scheduleNoMicIdleClose = () => {
    clearNoMicIdleTimer()
    noMicIdleTimer = setTimeout(() => {
      noMicIdleTimer = null
      if (!voiceSessionOpen || active) return
      setStatus('Voice paused. Tap Start voice chat to continue.')
      trackEvent('chat_live_stop', { reason: 'no_mic_idle' })
      stopVoiceInternal({ silent: false })
    }, VOICE_SESSION_IDLE_NO_MIC_MS)
  }

  const sendClientContentText = (instructionText) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: instructionText }] }],
          turnComplete: true,
        }
      }))
      // A turn requested but not yet answered counts as in flight (ADR-0026 §3.2).
      turnGate = nextTurnGate(turnGate, 'turnStarted')
      return true
    } catch (_) {
      return false
    }
  }

  // ADR-0026 §3 / invariant #25 — the ONLY place playback is cut and the turn gate cancelled.
  // reason: 'server' (Live's own `interrupted`) | 'user_text' (a chip or text turn into the
  // call) | 'mic_tap' (mic tap on an open session whose mic is not live) | 'voice_local' (the
  // visitor speaks over a tail the server already finished sending). A server interrupt
  // is unconditional; a local one cancels the gate only while a server turn is in flight, so
  // the reply to the act that cut the assistant off is never dropped. A second door (another
  // player.interrupt() or 'interrupted' gate event in this file) fails a source test.
  const interruptAssistant = (reason) => {
    turnGate = nextTurnGate(turnGate, reason === 'server' ? 'interrupted' : 'localInterrupt')
    player?.interrupt()
    turnInterrupted = true
  }

  // #25 by voice over a fully-delivered tail: Live sends audio faster than real time, so its
  // turnComplete often lands while the player still has seconds queued, and with no server
  // turn in flight there is nothing for Live to interrupt. The visitor's transcribed speech
  // then cuts playback locally. Only while NO turn is in flight (an idle gate); a turn in
  // flight is the server's to interrupt, and its own `interrupted` follows.
  // ADR-0026 addendum: Live's input transcription LAGS - the last fragment of the question can
  // land seconds after its answer was fully sent, while that answer still sounds - so WHEN the
  // visitor started speaking comes from the local mic, not from transcript arrival. A fragment
  // (the confirmation: it guards echo and noise) cuts only if the last voice ONSET came after
  // the playing turn's first output.
  let lastLoudFrameAt = null
  let lastVoiceOnsetAt = null
  let playingTurnFirstOutputAt = null
  let turnHasOutput = false
  const noteMicLevel = (rms) => {
    if (rms < VOICE_ONSET_RMS) return
    const now = Date.now()
    if (lastLoudFrameAt === null || now - lastLoudFrameAt >= VOICE_ONSET_SILENCE_MS) lastVoiceOnsetAt = now
    lastLoudFrameAt = now
  }
  const noteModelOutput = () => {
    if (turnHasOutput) return
    turnHasOutput = true
    playingTurnFirstOutputAt = Date.now()
  }
  const cutSoundingTailOnSpeech = () => {
    const spokeOverIt = lastVoiceOnsetAt !== null && playingTurnFirstOutputAt !== null && lastVoiceOnsetAt > playingTurnFirstOutputAt
    if (spokeOverIt && isIdleGate(turnGate) && player?.isPlaying()) interruptAssistant('voice_local')
  }

  /** A canned text turn (a project chip's prompt) into the live call: stop the assistant
   *  locally first, then send. False when no session is open (the caller falls back to text). */
  const sendUserText = (text) => {
    if (!voiceSessionOpen || !setupDone || !ws || ws.readyState !== WebSocket.OPEN) return false
    interruptAssistant('user_text')
    return sendClientContentText(String(text || ''))
  }

  const sendGreetingClientContent = (verbatim) => sendClientContentText(greetingInstruction(verbatim))

  const sendWarmFollowup = () => {
    if (userSpokeAfterGreeting) return false
    return sendClientContentText(WARM_FOLLOWUP_INSTRUCTION)
  }

  const resetDraftState = () => {
    userBubble = null
    assistantBubble = null
    userDraft = ''
    assistantDraft = ''
    turnToolCalls = []
    turnStartedAt = 0
    turnAudioInBytes = 0
    turnAudioOutBytes = 0
    turnInterrupted = false
  }

  const persistVoiceTurn = (userText, assistantText, toolCalls, telemetry = {}) => {
    const trimmedUser = (userText || '').trim()
    const trimmedAssistant = (assistantText || '').trim()
    if (!trimmedUser && !trimmedAssistant) return
    const root = resolveChatApiBase().replace(/\/+$/, '')
    const url = `${root}/api/live/transcript`
    const body = {
      sessionId: typeof getSessionId === 'function' ? getSessionId() : null,
      userText: trimmedUser,
      assistantText: trimmedAssistant,
      transport: lastLiveVoiceTransport || 'live',
      toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
      intent: typeof telemetry.intent === 'string' ? telemetry.intent : sessionIntent,
      turnDurationMs: Number.isFinite(telemetry.turnDurationMs) ? telemetry.turnDurationMs : undefined,
      audioInBytes: Number.isFinite(telemetry.audioInBytes) ? telemetry.audioInBytes : undefined,
      audioOutBytes: Number.isFinite(telemetry.audioOutBytes) ? telemetry.audioOutBytes : undefined,
      interrupted: typeof telemetry.interrupted === 'boolean' ? telemetry.interrupted : undefined,
    }
    // Strip undefined keys so the POST body stays tight and the backend's
    // pydantic validator skips them rather than seeing nulls.
    Object.keys(body).forEach((k) => { if (body[k] === undefined) delete body[k] })
    // Best-effort. Use keepalive so a turn fired right before close still ships.
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(() => {})
    } catch (_) {}
  }

  const syncMicChrome = () => {
    for (const btn of micButtons) {
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
      btn.classList.toggle('chat-composer__mic--live', active)
      btn.setAttribute(
        'aria-label',
        active ? 'Stop voice mode' : 'Start voice mode'
      )
    }
  }

  // `retrying` = the connect loop tearing down a failed attempt before its next round; the
  // start it belongs to is still current. Every other stop ends the start (bumps the epoch).
  // `failure` = the SESSION failed (an Error): a wait on the bubble or the connect is handed
  // that error to report, never read as the visitor hanging up.
  const stopVoiceInternal = ({ silent, retrying = false, failure = null } = {}) => {
    if (!retrying) {
      startEpoch += 1
      const abortWait = permissionWaitAbort
      clearPermissionWait()
      if (failure) {
        if (abortWait) abortWait({ failed: failure })
        else settleVoiceStart('error')
      } else {
        // Any other stop with the mic question still open is the visitor (or the page) ending
        // it: the wait ends now, and its hint goes with it.
        settleVoiceStart('hangup')
        if (abortWait) {
          setStatus('')
          abortWait({ aborted: true })
        }
      }
    }
    if (userBubble || assistantBubble) finalizeTurn()

    clearVoiceTimers()
    clearNoMicIdleTimer()
    clearWarmFollowupTimer()
    siteStateNotifier.reset()
    voiceSessionOpen = false
    wsOpened = false
    active = false
    sessionIntent = 'cold'
    greetingTurnComplete = false
    userSpokeAfterGreeting = false
    lastLiveVoiceTransport = null
    syncMicChrome()

    if (mediaSource && processor) {
      try {
        mediaSource.disconnect()
      } catch (_) {}
    }
    mediaSource = null

    if (processor && audioCtx) {
      try {
        processor.disconnect()
      } catch (_) {}
      processor.onaudioprocess = null
      if (processor.port) processor.port.onmessage = null
    }
    processor = null

    if (audioCtx) {
      audioCtx.close().catch(() => {})
      audioCtx = null
    }

    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }

    if (ws) {
      const w = ws
      detachWebSocketHandlers(w)
      ws = null
      if (w.readyState === WebSocket.OPEN) {
        try {
          w.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        } catch (_) {}
        try {
          w.close()
        } catch (_) {}
      } else if (w.readyState === WebSocket.CONNECTING) {
        try {
          w.close()
        } catch (_) {}
      }
    }

    player?.close()
    player = null
    setupDone = false

    if (pendingSetupLatch) {
      if (pendingSetupLatch.timeoutId != null) clearTimeout(pendingSetupLatch.timeoutId)
      const rj = pendingSetupLatch.reject
      pendingSetupLatch = null
      if (typeof rj === 'function') {
        try {
          const err = new Error('Voice stopped')
          err.name = 'LiveSetupAbort'
          rj(err)
        } catch (_) {}
      }
    }
    if (pendingWsOpenFail) {
      const fail = pendingWsOpenFail
      pendingWsOpenFail = null
      const err = new Error('Voice stopped')
      err.name = 'LiveSetupAbort'
      fail(err)
    }

    // Clear ALL three voice flags in one patch so chat.js's syncVoiceStartCta
    // sees a fully-idle state and the Start CTA can re-render. Forgetting
    // sessionOpen here was the "Start voice chat button hides completely after
    // first session" bug — sessionOpen stayed true across the stop, so
    // isVoiceSessionUi() kept hiding the button until page reload.
    patchLiveUi({ active: false, connecting: false, sessionOpen: false })

    if (!silent) {
      chatBus.emit('idle', { source: 'chat-live' })
    }

    resetDraftState()
    // The gate re-opens at session end too, not just at turnComplete. This is the one place
    // a session can end with a turn still cancelled, and this closure outlives the session —
    // so without this the NEXT session starts gated shut and drops its first model turn,
    // audio and transcript, in silence. (Not in resetDraftState: finalizeTurn runs that at
    // every turnComplete, and a second re-open there masked the gate's own transition.)
    turnGate = freshTurnGate()
    // voice_local state is per call: a call ended mid-answer must not leave its half-finished
    // turn standing in for the next call's first output.
    lastLoudFrameAt = null
    lastVoiceOnsetAt = null
    playingTurnFirstOutputAt = null
    turnHasOutput = false
  }

  const ensureAssistantBubble = () => {
    if (assistantBubble) return assistantBubble
    assistantBubble = appendChatBubble(messagesEl, 'assistant', '', true)
    syncEmptyState()
    scrollMessagesToBottom()
    return assistantBubble
  }

  const ensureUserBubble = () => {
    if (userBubble) return userBubble
    userBubble = appendChatBubble(messagesEl, 'user', '', false)
    syncEmptyState()
    scrollMessagesToBottom()
    return userBubble
  }

  const patchUserText = (fragment) => {
    if (!fragment) return
    markTurnStart()
    userDraft = `${userDraft}${fragment}`.trimStart()
    const el = ensureUserBubble().querySelector('.chat-msg__text')
    if (el) el.textContent = userDraft.trim()
    scrollMessagesToBottom()
  }

  const patchAssistantText = (fragment) => {
    if (!fragment) return
    markTurnStart()
    assistantDraft = `${assistantDraft}${fragment}`
    const el = ensureAssistantBubble().querySelector('.chat-msg__text')
    if (el) el.textContent = assistantDraft.trim()
    scrollMessagesToBottom()
  }

  // Safety net: the voice model sometimes SAYS "tap the on-screen button" for the
  // résumé without actually calling open_resume, leaving the promise with no button.
  // If this finished turn promised the résumé button and no open_resume fired, reveal
  // it through the same handler so the words are always backed by a button.
  const maybeRevealPromisedResumeButton = () => {
    if (typeof onToolCall !== 'function') return
    if (!shouldRevealResumeButton(assistantDraft, turnToolCalls)) return
    try {
      onToolCall('open_resume', {})
    } catch (_) {
      /* a safety net must never break the turn */
    }
  }

  const finalizeTurn = () => {
    if (userBubble) finalizeBubble(userBubble, userDraft.trim())
    if (assistantBubble) finalizeBubble(assistantBubble, assistantDraft.trim())
    maybeRevealPromisedResumeButton()
    // RECORDED, NEVER ACTED ON (ADR-0015 ss5.2). The alternative - navigating on the
    // strength of the model's prose - was rejected: a wrong reveal is a redundant button, a
    // wrong navigation hijacks someone mid-paragraph. If this number turns out non-trivial
    // on real traffic, THAT is the evidence for revisiting it.
    if (hasNavPromiseGap(assistantDraft, turnToolCalls)) {
      trackEvent('chat_nav_promise_gap', { modality: 'voice' })
    }
    // Fire-and-forget persist before clearing drafts. Mirrors the text-chat
    // persistence path so the admin panel sees voice turns alongside text turns.
    persistVoiceTurn(userDraft, assistantDraft, turnToolCalls, {
      intent: sessionIntent,
      turnDurationMs: turnStartedAt ? Math.max(0, Date.now() - turnStartedAt) : undefined,
      audioInBytes: turnAudioInBytes || undefined,
      audioOutBytes: turnAudioOutBytes || undefined,
      interrupted: turnInterrupted || undefined,
    })
    resetDraftState()
    scrollMessagesToBottom()
  }

  const handlePayload = async (raw) => {
    const text = await decodeWebSocketJsonPayload(raw)
    if (!text) return

    let msg = {}
    try {
      msg = JSON.parse(text)
    } catch (_) {
      return
    }

    if (!setupDone && pendingSetupLatch && msg.error) {
      const errField = msg.error
      const detail = typeof errField === 'string'
        ? errField
        : (typeof errField?.message === 'string' ? errField.message : String(errField?.code || 'Voice setup failed'))
      const err = new Error(detail)
      err.name = 'LiveSetupFailed'
      if (lastLiveVoiceTransport === 'relay') err.retryable = true
      rejectPendingSetupLatch(err)
      return
    }

    const setupPayload = msg.setupComplete ?? msg.setup_complete
    if (setupPayload != null && setupPayload !== false) {
      setupDone = true
      voiceUnavailableOnHost = false
      // A NEW session has been told nothing, so the dedupe memory starts empty - otherwise
      // the first note of this call is swallowed because the last call already said it.
      siteStateNotifier.reset()
      patchLiveUi({ sessionOpen: true })
      if (pendingSetupLatch) {
        if (pendingSetupLatch.timeoutId != null) clearTimeout(pendingSetupLatch.timeoutId)
        const res = pendingSetupLatch.resolve
        pendingSetupLatch = null
        if (typeof res === 'function') res()
      }
      chatBus.emit('streaming', { source: 'chat-live', model: 'live' })
    }

    const rootIn = msg.inputTranscription?.text
    const rootOut = msg.outputTranscription?.text
    if (rootIn) {
      cutSoundingTailOnSpeech()
      patchUserText(rootIn)
      userSpokeAfterGreeting = true
      clearWarmFollowupTimer()
    }
    // Model output means a server turn is in flight (ADR-0026 §3.2), so a local act now cancels
    // it. turnStarted never re-opens a cancelled gate; only turnComplete does.
    if (rootOut) turnGate = nextTurnGate(turnGate, 'turnStarted')
    if (rootOut && acceptsTurnOutput(turnGate)) {
      noteModelOutput()
      patchAssistantText(rootOut)
    }

    const sc = msg.serverContent || msg.server_content
    if (sc) {
      if (sc.interrupted) interruptAssistant('server')
      const modelParts = sc.modelTurn?.parts
      if (sc.outputTranscription?.text || (Array.isArray(modelParts) && modelParts.length)) {
        turnGate = nextTurnGate(turnGate, 'turnStarted')
        // Output of a cancelled turn never plays, so it does not count as the playing turn.
        if (acceptsTurnOutput(turnGate)) noteModelOutput()
      }

      if (sc.inputTranscription?.text) {
        cutSoundingTailOnSpeech()
        patchUserText(sc.inputTranscription.text)
        userSpokeAfterGreeting = true
        clearWarmFollowupTimer()
      }
      if (sc.outputTranscription?.text && acceptsTurnOutput(turnGate)) patchAssistantText(sc.outputTranscription.text)

      const parts = sc.modelTurn?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const inline = part.inlineData || part.inline_data
          const mime = inline?.mimeType || inline?.mime_type || ''
          const data = inline?.data
          if (mime.includes('audio/pcm') && data && player && acceptsTurnOutput(turnGate)) {
            // Approximate decoded byte count from the base64 string length
            // (~3 bytes per 4 base64 chars). Cheap, off by a few bytes at most.
            turnAudioOutBytes += Math.floor((String(data).length * 3) / 4)
            const { floats, rate } = decodePcmBase64(data, mime)
            player.enqueue(floats, rate).catch(() => {})
          }
          if (part.text && acceptsTurnOutput(turnGate)) patchAssistantText(part.text)
        }
      }

      if (sc.turnComplete || sc.turn_complete) {
        turnGate = nextTurnGate(turnGate, 'turnComplete')
        turnHasOutput = false
        finalizeTurn()
        // First turnComplete after the greeting = the greeting finished playing.
        // For warm sessions where the visitor hasn't spoken yet, schedule the
        // follow-up nudge ("you can ask me about…"). Cold sessions don't
        // auto-follow-up: the visitor has just been shown the permission sheet
        // (widening the nudge is out of scope, ADR-0026 §2).
        if (!greetingTurnComplete) {
          greetingTurnComplete = true
          if (sessionIntent === 'warm' && active && !userSpokeAfterGreeting) {
            clearWarmFollowupTimer()
            warmFollowupTimer = setTimeout(() => {
              warmFollowupTimer = null
              if (!voiceSessionOpen || !active || userSpokeAfterGreeting) return
              sendWarmFollowup()
            }, VOICE_WARM_FOLLOWUP_MS)
          }
        }
      }
    }

    const toolCall = msg.toolCall || msg.tool_call
    if (toolCall && Array.isArray(toolCall.functionCalls || toolCall.function_calls)) {
      const calls = toolCall.functionCalls || toolCall.function_calls
      const responses = []
      for (const call of calls) {
        const id = call?.id
        const name = typeof call?.name === 'string' ? call.name : ''
        const args = call?.args && typeof call.args === 'object' ? call.args : {}
        let response = { result: 'ok' }
        if (typeof onToolCall === 'function' && name) {
          try {
            const out = await onToolCall(name, args)
            if (out && typeof out === 'object') response = out
          } catch (err) {
            response = { error: err?.message || 'tool_failed' }
          }
        } else if (name) {
          response = { error: 'no_handler' }
        }
        turnToolCalls.push({ id, name, args, response })
        responses.push({ id, name, response })
      }
      if (responses.length && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }))
        } catch (_) {}
      }
    }
  }

  /** Open the live WebSocket session: POST /api/live/session, connect, wait
   *  for setupComplete. Does NOT attach the microphone — that's `attachMicrophoneInternal`.
   *  Splits the old monolithic startVoice so we can play the greeting before
   *  the visitor has consented to the mic. Throws on failure (caller handles). */
  const openVoiceSessionInternal = async () => {
    const root = resolveChatApiBase().replace(/\/+$/, '')
    const postUrl = `${root}/api/live/session`
    // The visitor can end the start while the mint is in flight; nothing after it may open a
    // socket for a call that is already over.
    const epoch = startEpoch
    const abortIfStale = () => {
      if (epoch === startEpoch) return
      const err = new Error('Voice stopped')
      err.name = 'LiveSetupAbort'
      throw err
    }

    for (let connectRound = 0; connectRound <= VOICE_CONNECT_MAX_ROUNDS; connectRound++) {
      if (connectRound > 0) {
        // Every retry teardown first checks the start is still current: an ended start's loop
        // must not stop `ws` — by now it may be the next call's.
        abortIfStale()
        stopVoiceInternal({ silent: true, retrying: true })
        setStatus(`Reconnecting voice… (attempt ${connectRound + 1}/${VOICE_CONNECT_MAX_ROUNDS + 1})`)
        trackEvent('chat_live_connect_retry', { round: connectRound })
        await sleep(VOICE_CONNECT_ROUND_BACKOFF_MS[connectRound - 1] || 1600)
        abortIfStale()
      }

      let body
      try {
        body = await postLiveVoiceSession(postUrl, getSessionId(), {
          onRetry: (attempt, maxAttempts) => {
            if (epoch !== startEpoch) return // an ended start reports nothing
            setStatus(`Connecting voice… (retry ${attempt}/${maxAttempts})`)
            trackEvent('chat_live_session_retry', { attempt, maxAttempts })
          }
        })
      } catch (sessionErr) {
        abortIfStale()
        if (isVoiceRetryableError(sessionErr) && connectRound < VOICE_CONNECT_MAX_ROUNDS) {
          continue
        }
        throw sessionErr
      }
      abortIfStale()

      const { websocketUrl, handshake } = body
      const wsUrlStr = String(websocketUrl)
      const isRelayWsPath = wsUrlStr.includes('/api/live/relay/')
      const firstClientSetup = handshake

      lastLiveVoiceTransport = typeof body.liveVoiceTransport === 'string' ? body.liveVoiceTransport : null

      const transport = lastLiveVoiceTransport || ''
      const voiceBrowserExperience = typeof body.voiceBrowserExperience === 'string'
        ? body.voiceBrowserExperience
        : ''
      // ADR-0007 Phase 1: browser-direct voice is the path. The browser opens Google's
      // Live WSS itself with the single-use ephemeral token (no server relay).
      if (!wsUrlStr.startsWith('wss://') && !wsUrlStr.startsWith('ws://')) {
        throw new Error('Invalid voice session URL.')
      }

      const liveSetupErr = (message) => {
        const err = new Error(message)
        err.name = 'LiveSetupFailed'
        if (isRelayWsPath) err.retryable = true
        return err
      }

      try {
        voiceSessionOpen = true
        setupDone = false
        wsOpened = false
        player = new PcmJitterPlayer({
          onLevel: emitLevel ? (rms) => emitLevel('output', rms) : undefined,
        })

        const setupReadyPromise = new Promise((resolve, reject) => {
          pendingSetupLatch = { resolve, reject, timeoutId: null }
          pendingSetupLatch.timeoutId = setTimeout(() => {
            rejectPendingSetupLatch(liveSetupErr(liveSetupTimeoutMessage(isRelayWsPath)))
          }, LIVE_SETUP_WAIT_MS)
        })
        // A stop while the socket is still opening rejects this latch before it is awaited
        // (ADR-0028: the cold path can close during the connect); it is awaited below.
        setupReadyPromise.catch(() => {})

        const wsOpenPromise = new Promise((resolve, reject) => {
          const openTimer = setTimeout(() => {
            reject(liveSetupErr('Voice WebSocket did not connect in time.'))
          }, LIVE_WS_OPEN_MS)
          const settleOpen = () => {
            clearTimeout(openTimer)
            wsOpened = true
            bumpVoiceWsIdleTimer()
            if (!isRelayWsPath) {
              try {
                ws.send(JSON.stringify(firstClientSetup))
              } catch (sendErr) {
                reject(liveSetupErr(sendErr?.message || 'Could not start voice handshake.'))
                return
              }
            }
            resolve()
          }
          const settleOpenFail = (err) => {
            clearTimeout(openTimer)
            if (err && typeof err === 'object' && err.name === 'LiveSetupFailed' && isRelayWsPath) {
              err.retryable = true
            }
            reject(err)
          }
          // A stop while the socket is still CONNECTING ends this wait at once (LiveSetupAbort)
          // instead of leaving it to LIVE_WS_OPEN_MS and a "did not connect" nobody asked for.
          pendingWsOpenFail = settleOpenFail
          ws = new WebSocket(websocketUrl)
          ws.onopen = () => settleOpen()
          ws.onmessage = (ev) => {
            bumpVoiceWsIdleTimer()
            void handlePayload(ev.data)
          }
          ws.onerror = () => {
            trackEvent('chat_live_error', { phase: 'websocket' })
            if (!wsOpened) {
              settleOpenFail(liveSetupErr('Voice WebSocket connection failed.'))
            }
          }
          ws.onclose = (ev) => {
            if (!voiceSessionOpen) return
            const ready = setupDone
            const code = ev.code
            const reason = ev.reason
            const closeMsg = isRelayWsPath
              ? voiceRelayCloseUserMessage(code, reason)
              : voiceSessionEarlyCloseUserMessage(code, reason)
            const transportForCloseMsg = lastLiveVoiceTransport
            const markHostBlocked = !ready
              && transportForCloseMsg === 'relay'
              && (code === 1011 || code === 4403 || String(reason || '').toLowerCase().includes('internal'))
            let latchRejected = false
            if (!ready) {
              const err = liveSetupErr(closeMsg)
              if (!wsOpened) {
                settleOpenFail(err)
              }
              latchRejected = rejectPendingSetupLatch(err)
            }
            if (markHostBlocked) voiceUnavailableOnHost = true
            // Before ready: the connect loop decides (retry or fail). After: the session died.
            stopVoiceInternal({ silent: true, retrying: !ready, failure: ready ? liveSetupErr(closeMsg) : null })
            if (!ready && !latchRejected) {
              setStatus(closeMsg, 'error')
              trackEvent('chat_live_error', { phase: 'ws_closed_before_ready', code })
              chatBus.emit('error', { source: 'chat-live', message: 'WebSocket closed before ready' })
            }
          }
        })

        try {
          await wsOpenPromise
        } finally {
          pendingWsOpenFail = null
        }
        await setupReadyPromise
        return
      } catch (connectErr) {
        // A start that already ended (the visitor hung up while this socket was connecting)
        // must not stop anything: by now `ws` may be the NEXT call's socket.
        abortIfStale()
        const retry = isVoiceRetryableSetupFailure(connectErr, isRelayWsPath)
          && connectRound < VOICE_CONNECT_MAX_ROUNDS
        stopVoiceInternal({ silent: true, retrying: retry, failure: retry || connectErr?.name === 'LiveSetupAbort' ? null : connectErr })
        if (retry) continue
        throw connectErr
      }
    }
  }

  /** Attach the mic to an open session: acquireMicStream() then wireMicrophone() (ADR-0028 §2).
   *  The warm path and a mic tap on an open, mic-less session come through here. */
  // ONE attach in flight at a time (M4 critic): a manual mic tap during the greeting and the
  // start-of-session attach can both reach getUserMedia - `active` is still false
  // while the browser's permission prompt is open - and the first stream was overwritten and
  // never stopped, leaving the mic indicator on after hang-up. Every trigger shares this promise.
  let attachInFlight = null
  const attachMicrophoneInternal = () => {
    if (attachInFlight) return attachInFlight
    attachInFlight = attachMicrophoneOnce().finally(() => { attachInFlight = null })
    return attachInFlight
  }

  const attachMicrophoneOnce = async () => {
    if (active) return
    if (!voiceSessionOpen || !setupDone) throw new Error('voice session not ready')
    return wireMicrophone(await acquireMicStream())
  }

  // ADR-0028 §2: getUserMedia only — no session precondition, so the cold path can raise the
  // bubble at the tap, in parallel with the connect. ONE in flight: every caller shares it.
  let micAcquireInFlight = null
  const acquireMicStream = () => {
    if (micAcquireInFlight) return micAcquireInFlight
    // Called synchronously (the executor runs now), so the tap's user activation still holds.
    const acquiring = new Promise((resolve) => resolve(navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)))
      .finally(() => { if (micAcquireInFlight === acquiring) micAcquireInFlight = null })
    micAcquireInFlight = acquiring
    return acquiring
  }

  // The pipeline: needs an open, set-up session. A stream that arrives after the call ended is
  // released at once rather than wired into a pipeline nothing will ever stop.
  const wireMicrophone = async (acquired) => {
    if (!voiceSessionOpen || !setupDone || active) {
      releaseStream(acquired)
      if (active) return
      throw new Error('voice session ended before the microphone was allowed')
    }
    stream = acquired

    audioCtx = new AudioContext()
    const inRate = audioCtx.sampleRate
    await audioCtx.resume()

    const sendMicFrame = (floatChannelData) => {
      if (!active || !setupDone || !ws || ws.readyState !== WebSocket.OPEN) return
      noteMicLevel(pcmFrameRms(floatChannelData))
      const pcmInput = downsampleFloat32(floatChannelData, inRate, INPUT_RATE)
      const bytes = floatTo16BitPCM(pcmInput)
      try {
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: `audio/pcm;rate=${INPUT_RATE}`,
              data: base64FromBytes(bytes)
            }
          }
        }))
        // Count raw decoded bytes (pre-base64-encode) so the admin dashboard
        // can show a comparable mic vs model audio volume.
        turnAudioInBytes += bytes.length
      } catch (_) {}
    }

    const mute = audioCtx.createGain()
    mute.gain.value = 0
    mute.connect(audioCtx.destination)

    let micTapOk = false
    if (audioCtx.audioWorklet && typeof audioCtx.audioWorklet.addModule === 'function') {
      try {
        const blob = new Blob([MIC_CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' })
        const modUrl = URL.createObjectURL(blob)
        await audioCtx.audioWorklet.addModule(modUrl)
        URL.revokeObjectURL(modUrl)
        processor = new AudioWorkletNode(audioCtx, 'gvp-mic-pcm-sender', {
          numberOfInputs: 1,
          numberOfOutputs: 1
        })
        processor.port.onmessage = (ev) => {
          const buf = ev.data
          if (!(buf instanceof Float32Array)) return
          if (emitLevel) emitLevel('input', pcmFrameRms(buf))
          sendMicFrame(buf)
        }
        processor.connect(mute)
        micTapOk = true
      } catch (_) {
        processor = null
      }
    }
    if (!micTapOk) {
      processor = audioCtx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        const ch = event.inputBuffer.getChannelData(0)
        if (emitLevel) emitLevel('input', pcmFrameRms(ch))
        sendMicFrame(ch)
      }
      processor.connect(mute)
    }

    active = true
    clearNoMicIdleTimer()
    syncMicChrome()
    patchLiveUi({ active: true, connecting: false, sessionOpen: true })
    trackEvent('chat_live_start', { permissionBefore: startPermission, outcome: 'granted' })

    bumpVoiceWsIdleTimer()
    if (!voiceMaxSessionTimer) {
      voiceMaxSessionTimer = setTimeout(() => {
        voiceMaxSessionTimer = null
        if (!voiceSessionOpen) return
        setStatus('Voice session time limit reached. Tap Start voice chat to begin again.', 'error')
        trackEvent('chat_live_stop', { reason: 'max_session' })
        stopVoiceInternal({ silent: false })
      }, VOICE_MAX_SESSION_MS)
    }

    mediaSource = audioCtx.createMediaStreamSource(stream)
    mediaSource.connect(processor)
  }

  /** Public: open session and greet. `intent` picks the greeting text and the follow-up nudge:
   *  warm = permission already granted, cold = not yet granted or unknown. 'auto' detects via
   *  the Permissions API.
   *  Warm (`granted`): open → greet → attach at once (ADR-0026 §2), as before.
   *  Otherwise (ADR-0028): mic FIRST — the bubble opens at the tap, the session connects in
   *  parallel, and the greeting is sent only after the grant, with the mic already wired. */
  const startVoice = async ({ intent = 'auto' } = {}) => {
    if (isTextPending()) {
      setStatus('Wait for the text reply to finish, then try voice.', 'error')
      return
    }

    if (!isPanelOpen()) openPanel()

    const gateMsg = voiceCaptureGateMessage()
    if (gateMsg) {
      setStatus(gateMsg, 'error')
      trackEvent('chat_live_blocked', { reason: 'insecure_or_no_mediadevices' })
      return
    }

    if (voiceUnavailableOnHost) {
      setStatus(VOICE_UNAVAILABLE_ON_HOST_MSG, 'error')
      trackEvent('chat_live_blocked', { reason: 'voice_host_endpoint' })
      return
    }

    if (voiceConnectInFlight) return
    voiceConnectInFlight = true
    lastLiveVoiceTransport = null

    patchLiveUi({ connecting: true, active: false, sessionOpen: false })
    setStatus('Connecting voice…')
    chatBus.emit('thinking', { source: 'chat-live' })

    // The permission STATE picks warm/cold (and so the greeting text). Read it once, for
    // every intent, not only 'auto'.
    const perm = await detectMicPermissionState()
    let resolvedIntent = intent
    if (resolvedIntent === 'auto') {
      resolvedIntent = perm === 'granted' ? 'warm' : 'cold'
    }
    sessionIntent = resolvedIntent
    startPermission = perm
    voiceStartRecord = { permissionBefore: perm, requestedAt: null }

    // Greet only the first time per conversation. Subsequent voice sessions in the same
    // conversation just listen — a repeat "Hi, I'm your AI Assistant" mid-thread is grating.
    const greetText = resolvedIntent === 'warm' ? GREETING_TEXT_WARM : GREETING_TEXT_COLD
    const greet = () => {
      const shouldGreet = !conversationGreeted
      greetingTurnComplete = !shouldGreet  // skip the warm follow-up if we didn't greet
      userSpokeAfterGreeting = false
      if (!shouldGreet) return
      if (!sendGreetingClientContent(greetText)) {
        throw new Error('Could not send greeting to voice service.')
      }
      conversationGreeted = true
      chatBus.emit('streaming', { source: 'chat-live', model: 'live' })
    }
    // ADR-0028 addendum (N-P1): the denied fallback — the greeting as a transcript line, and the
    // composer ready for the text answer.
    const greetAsText = () => {
      if (!conversationGreeted) {
        appendChatBubble(messagesEl, 'assistant', greetText, false)
        conversationGreeted = true
        syncEmptyState()
        scrollMessagesToBottom()
      }
      if (typeof focusComposer === 'function') focusComposer()
    }

    try {
      if (perm === 'granted') {
        await openVoiceSessionInternal()
        greet()
        // ADR-0026 §2 / invariant #25: the mic is requested right after the greeting is sent.
        // The greeting audio plays while we acquire the stream; mic input is muted to local
        // speakers via the zero-gain node, so there's no feedback loop.
        try {
          await attachMicrophoneInternal()
          settleVoiceStart('granted')
          setStatus('Listening… speak about Marwan\'s work.')
        } catch (micErr) {
          // The visitor hung up while getUserMedia was pending: the call is over, so the late
          // answer must not re-open the UI, report an error, or arm the no-mic sweep.
          if (!voiceSessionOpen) return
          const blocked = micErr?.name === 'NotAllowedError' || micErr?.name === 'SecurityError'
          settleVoiceStart(blocked ? 'denied' : 'error')
          // Permission "granted" but stream acquisition failed (mic busy, denied, etc.).
          // Fall back to the cold path: session stays open for the greeting; visitor can
          // retry by tapping the big mic.
          sessionIntent = 'cold'
          patchLiveUi({ active: false, connecting: false, sessionOpen: true })
          setStatus(micAccessUserMessage(micErr), 'error')
          scheduleNoMicIdleClose()
        }
        return
      }

      // ADR-0028 §3.2 — mic first. Both requests go out in this task: the bubble opens at the
      // tap, and the mint + WebSocket + setup run while the visitor reads it.
      // Already 'denied' (N-P1): the browser answers without a bubble, so there is nothing to
      // explain and no session is minted for an answer that is almost certainly "no".
      const epoch = startEpoch
      const micP = acquireMicStream()
      voiceStartRecord.requestedAt = Date.now()
      const sessionP = perm === 'denied' ? null : openVoiceSessionInternal()
      sessionP?.catch(() => {}) // awaited below only after the grant; never unhandled meanwhile
      if (perm !== 'denied') setStatus(MIC_PERMISSION_HINT)
      // A non-granted answer closes the call: no greeting is ever sent for it.
      const closeWithoutGreeting = (outcome, copy) => {
        settleVoiceStart(outcome)
        trackEvent('chat_live_stop', { reason: 'mic_permission', permissionBefore: perm, outcome })
        stopVoiceInternal({ silent: false }) // not silent: the lifecycle (aura) returns to idle
        setStatus(copy, 'error')
      }
      // Whatever settles first: the visitor's answer, VOICE_PERMISSION_WAIT_MS, or a stop. The
      // bubble can outlive the call; a stream it yields after that is released, never wired.
      const answer = await new Promise((resolve) => {
        micP.then((stream) => resolve({ stream }), (error) => resolve({ error }))
        permissionWaitTimer = setTimeout(() => resolve({ timeout: true }), VOICE_PERMISSION_WAIT_MS)
        permissionWaitAbort = (ended) => resolve(ended)
      })
      clearPermissionWait()
      if (!answer.stream && !answer.error) {
        micP.then(releaseStream, () => {})
        if (micAcquireInFlight === micP) micAcquireInFlight = null // the next Start asks afresh
        // The session died under the bubble: a connect error, reported as one (outer catch).
        if (answer.failed) throw answer.failed
        if (answer.aborted || epoch !== startEpoch) return
        closeWithoutGreeting('timeout', MIC_DISMISSED_MSG)
        return
      }
      const acquired = answer.stream
      if (answer.error) {
        const micErr = answer.error
        if (epoch !== startEpoch) return
        const blocked = micErr?.name === 'NotAllowedError' || micErr?.name === 'SecurityError'
        // A dismissed bubble rejects exactly like a block; only the browser's own state tells
        // them apart. 'unknown' (no Permissions API) is not a claim of dismissal.
        const after = blocked ? await detectMicPermissionState() : ''
        if (epoch !== startEpoch) return
        if (after === 'prompt') {
          closeWithoutGreeting('dismissed', MIC_DISMISSED_MSG)
          return
        }
        // Denied, or a device error (NotFound / NotReadable / …): close, today's copy. Only a
        // denial gets the text fallback (N-P1) — nobody is spoken to who cannot answer by voice.
        closeWithoutGreeting(blocked ? 'denied' : 'error', micAccessUserMessage(micErr))
        if (blocked) greetAsText()
        return
      }
      if (epoch !== startEpoch) { releaseStream(acquired); return }
      settleVoiceStart('granted')
      if (!setupDone) setStatus('Connecting voice…') // the hint goes with the bubble
      // The granted mic waits on the session — or on a stop, which releases it at once rather
      // than when a CONNECTING socket finally gives up. (A stale 'denied' that the browser
      // granted after all connects now.)
      const connecting = sessionP || openVoiceSessionInternal()
      const session = await new Promise((resolve) => {
        connecting.then(() => resolve({ ok: true }), (error) => resolve({ error }))
        permissionWaitAbort = (ended) => resolve(ended)
      })
      clearPermissionWait()
      // Anything but a session that came up for THIS start releases the granted mic.
      if (!session.ok || epoch !== startEpoch) {
        releaseStream(acquired)
        if (session.error || session.failed) throw session.error || session.failed
        return
      }
      await wireMicrophone(acquired)
      // The mic is live: the greeting's first frame is heard, so it can be talked over (#25).
      greet()
      setStatus('Listening… speak about Marwan\'s work.')
    } catch (error) {
      const ename = error instanceof Error ? error.name : ''
      settleVoiceStart(ename === 'LiveSetupAbort' ? 'hangup' : 'error')
      stopVoiceInternal({ silent: true })
      if (ename === 'LiveSetupAbort') {
        return
      }
      let msg = ename === 'LiveSetupFailed' && error instanceof Error
        ? error.message
        : micAccessUserMessage(error)
      if (isVoiceRetryableError(error)) {
        msg = 'Voice could not connect after several tries. The chat API may still be warming up (cold start) or is unreachable — wait a moment and tap Start voice chat again.'
      }
      setStatus(msg, 'error')
      trackEvent('chat_live_error', { phase: 'start', message: msg })
      chatBus.emit('error', { source: 'chat-live', message: msg })
    } finally {
      voiceConnectInFlight = false
    }
  }

  /** Public: attach the mic to a session that's already open in cold state.
   *  When no session is open yet, fall through to startVoice (which will pick
   *  warm/cold via the permissions API). */
  const attachMicrophone = async () => {
    if (voiceConnectInFlight) return
    if (!voiceSessionOpen || !setupDone) {
      return startVoice({ intent: 'auto' })
    }
    if (active) return
    try {
      await attachMicrophoneInternal()
      setStatus('Listening… speak about Marwan\'s work.')
    } catch (micErr) {
      if (!voiceSessionOpen) return // the visitor hung up; not an error worth reporting
      setStatus(micAccessUserMessage(micErr), 'error')
      trackEvent('chat_live_error', { phase: 'attach_mic', message: micAccessUserMessage(micErr) })
    }
  }

  const onMicClick = (event) => {
    const btn = event?.currentTarget
    if (!active && btn && btn.disabled) return

    if (active) {
      trackEvent('chat_live_stop', {})
      stopVoiceInternal({ silent: false })
      setStatus('')
      return
    }

    // The permission sheet is still open (an attach is pending): the tap is the visitor's
    // "End". startVoice is still awaiting that attach, so without this the tap could only cut
    // playback. stopVoiceInternal ends the call; attachMicrophoneOnce releases a mic the
    // visitor allows afterwards.
    // ADR-0028: the cold path's mic-first wait is the same sheet (an acquire with no attach).
    if (attachInFlight || micAcquireInFlight) {
      trackEvent('chat_live_stop', { reason: 'abort_mic_prompt' })
      stopVoiceInternal({ silent: false })
      setStatus('')
      return
    }

    // Session open but the mic is not live (attach refused / failed, greeting playing).
    // Tapping the mic now means "stop, I'm ready": cut the assistant off locally BEFORE the
    // permission sheet can appear over still-playing audio (ADR-0026 §3.1), then attach.
    if (voiceSessionOpen && setupDone) {
      interruptAssistant('mic_tap')
      void attachMicrophone()
      return
    }

    // Mid-connect: the visitor wants to abort. stopVoiceInternal handles a
    // CONNECTING WebSocket cleanly + rejects the pendingSetupLatch so the
    // in-flight startVoice() promise unwinds without surfacing an error chip.
    // Previously this was a silent no-op — the "End" button looked broken
    // for the 0.5-2s mint window and any retry rounds after a flaky attempt.
    if (voiceConnectInFlight) {
      trackEvent('chat_live_stop', { reason: 'abort_connecting' })
      stopVoiceInternal({ silent: false })
      setStatus('')
      return
    }

    if (typeof onVoiceLauncherRequest === 'function' && onVoiceLauncherRequest({ button: btn })) {
      return
    }

    void startVoice()
  }

  for (const btn of micButtons) {
    btn.addEventListener('click', onMicClick)
  }

  syncMicChrome()

  const dispose = () => {
    for (const btn of micButtons) {
      delete btn.dataset.gvpChatLiveVoice
      btn.removeEventListener('click', onMicClick)
    }
    // The store is a module singleton that outlives this binding, so a subscription left
    // behind here keeps a dead session's notifier alive for the rest of the page — and, in
    // a test file where each case boots its own chat, for the rest of the file.
    unsubscribeSiteState()
    stopVoiceInternal({ silent: true })
  }

  // Object return (vs. the old bare dispose function) lets chat.js drive voice
  // programmatically — Phase 2's chooser big-mic and Phase 4's hero mic both
  // call .startVoice() / .attachMicrophone() directly.
  return {
    dispose,
    startVoice,
    attachMicrophone,
    stopVoice: ({ silent } = {}) => stopVoiceInternal({ silent }),
    /** Re-arm the greeting (Phase 5). Called from chat.js resetConversation so
     *  Start Over makes the agent say hello again. */
    resetGreet: () => { conversationGreeted = false },
    isActive: () => active,
    isSessionOpen: () => voiceSessionOpen && setupDone,
    /** Put a canned text turn (a project chip's prompt) to the live model. False when no
     *  session is open, so the caller can fall back to the text chat. */
    sendUserText,
    getSessionIntent: () => sessionIntent,
  }
}
