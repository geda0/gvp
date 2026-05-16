/**
 * Gemini Live (browser WebSocket): mic capture + PCM playback + transcript bubbles.
 */

import { trackEvent } from './analytics.js'
import { chatBus } from './chat-bus.js'
import { chatApiUrl, chatVoiceFeatureEnabled } from './site-config.js'

const INPUT_RATE = 16000

/** Hard cap on queued PCM chunks. At ~1s/chunk (Gemini Live's typical output
 *  cadence) this is ~17 minutes of buffer — well above any single turn, well
 *  below memory pressure. When hit, the player drops NEW chunks via
 *  backpressure (see PcmJitterPlayer.enqueue). The old behavior flushed the
 *  *queue* mid-reply, which audibly cut the agent off ("…and then we…" stops,
 *  next chunk starts a new sentence) — strictly worse than dropping incoming.
 *  Real barge-in still goes through `serverContent.interrupted` → interrupt(). */
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
const GREETING_TEXT_COLD = "Hi! I'm your AI Assistant. Just tap the mic to talk."
const GREETING_TEXT_WARM = "Hi! I'm your AI Assistant."
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
    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
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
      ? `Voice relay expired (${r}). Tap the mic again.`
      : 'Voice relay link expired. Tap the mic again to start a new session.'
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
    const ctx = await this.ensure(sampleRate)
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

  close() {
    this.interrupt()
    if (this.ctx) this.ctx.close().catch(() => {})
    this.ctx = null
  }
}

/** Best-effort mic permission state — 'granted' | 'denied' | 'prompt' | 'unknown'.
 *  'granted' is the only state where we auto-attach the mic on session open
 *  (warm path); everything else lands in the cold path so the visitor explicitly
 *  consents via the big-mic tap. */
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
  if (!chatVoiceFeatureEnabled) return () => {}
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
    onAudioLevels
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
      setStatus('Voice closed after a long quiet period. Tap the mic to try again.', 'error')
      trackEvent('chat_live_stop', { reason: 'ws_idle' })
      stopVoiceInternal({ silent: false })
    }, VOICE_WS_IDLE_MS)
  }

  let userBubble = null
  let assistantBubble = null
  let userDraft = ''
  let assistantDraft = ''
  let turnToolCalls = []

  /** Voice intent for the current session. 'warm' = mic auto-attached after the
   *  greeting (permission was already granted); 'cold' = greeting plays, mic
   *  waits for an explicit user tap. Decides whether a follow-up prompt fires
   *  after the greeting completes and the visitor stays silent. */
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
      setStatus('Voice paused. Tap the mic to start talking.')
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
      return true
    } catch (_) {
      return false
    }
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
  }

  const persistVoiceTurn = (userText, assistantText, toolCalls) => {
    const trimmedUser = (userText || '').trim()
    const trimmedAssistant = (assistantText || '').trim()
    if (!trimmedUser && !trimmedAssistant) return
    const root = resolveChatApiBase().replace(/\/+$/, '')
    const url = `${root}/api/live/transcript`
    const body = {
      sessionId: typeof getSessionId === 'function' ? getSessionId() : null,
      userText: trimmedUser,
      assistantText: trimmedAssistant,
      capturedAt: new Date().toISOString(),
      transport: lastLiveVoiceTransport || 'live',
      toolCalls: Array.isArray(toolCalls) ? toolCalls : []
    }
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

  const stopVoiceInternal = ({ silent } = {}) => {
    if (userBubble || assistantBubble) finalizeTurn()

    clearVoiceTimers()
    clearNoMicIdleTimer()
    clearWarmFollowupTimer()
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

    patchLiveUi({ active: false, connecting: false })

    if (!silent) {
      chatBus.emit('idle', { source: 'chat-live' })
    }

    resetDraftState()
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
    userDraft = `${userDraft}${fragment}`.trimStart()
    const el = ensureUserBubble().querySelector('.chat-msg__text')
    if (el) el.textContent = userDraft.trim()
    scrollMessagesToBottom()
  }

  const patchAssistantText = (fragment) => {
    if (!fragment) return
    assistantDraft = `${assistantDraft}${fragment}`
    const el = ensureAssistantBubble().querySelector('.chat-msg__text')
    if (el) el.textContent = assistantDraft.trim()
    scrollMessagesToBottom()
  }

  const finalizeTurn = () => {
    if (userBubble) finalizeBubble(userBubble, userDraft.trim())
    if (assistantBubble) finalizeBubble(assistantBubble, assistantDraft.trim())
    // Fire-and-forget persist before clearing drafts. Mirrors the text-chat
    // persistence path so the admin panel sees voice turns alongside text turns.
    persistVoiceTurn(userDraft, assistantDraft, turnToolCalls)
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
      patchUserText(rootIn)
      userSpokeAfterGreeting = true
      clearWarmFollowupTimer()
    }
    if (rootOut) patchAssistantText(rootOut)

    const sc = msg.serverContent || msg.server_content
    if (sc) {
      if (sc.interrupted) {
        player?.interrupt()
      }

      if (sc.inputTranscription?.text) {
        patchUserText(sc.inputTranscription.text)
        userSpokeAfterGreeting = true
        clearWarmFollowupTimer()
      }
      if (sc.outputTranscription?.text) patchAssistantText(sc.outputTranscription.text)

      const parts = sc.modelTurn?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const inline = part.inlineData || part.inline_data
          const mime = inline?.mimeType || inline?.mime_type || ''
          const data = inline?.data
          if (mime.includes('audio/pcm') && data && player) {
            const { floats, rate } = decodePcmBase64(data, mime)
            player.enqueue(floats, rate).catch(() => {})
          }
          if (part.text) patchAssistantText(part.text)
        }
      }

      if (sc.turnComplete || sc.turn_complete) {
        finalizeTurn()
        // First turnComplete after the greeting = the greeting finished playing.
        // For warm sessions where the visitor hasn't spoken yet, schedule the
        // follow-up nudge ("you can ask me about…"). Cold sessions don't
        // auto-follow-up because the visitor still needs to grant mic permission.
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

    for (let connectRound = 0; connectRound <= VOICE_CONNECT_MAX_ROUNDS; connectRound++) {
      if (connectRound > 0) {
        stopVoiceInternal({ silent: true })
        setStatus(`Reconnecting voice… (attempt ${connectRound + 1}/${VOICE_CONNECT_MAX_ROUNDS + 1})`)
        trackEvent('chat_live_connect_retry', { round: connectRound })
        await sleep(VOICE_CONNECT_ROUND_BACKOFF_MS[connectRound - 1] || 1600)
      }

      let body
      try {
        body = await postLiveVoiceSession(postUrl, getSessionId(), {
          onRetry: (attempt, maxAttempts) => {
            setStatus(`Connecting voice… (retry ${attempt}/${maxAttempts})`)
            trackEvent('chat_live_session_retry', { attempt, maxAttempts })
          }
        })
      } catch (sessionErr) {
        if (isVoiceRetryableError(sessionErr) && connectRound < VOICE_CONNECT_MAX_ROUNDS) {
          continue
        }
        throw sessionErr
      }

      const { websocketUrl, handshake } = body
      const wsUrlStr = String(websocketUrl)
      const isRelayWsPath = wsUrlStr.includes('/api/live/relay/')
      const firstClientSetup = handshake

      lastLiveVoiceTransport = typeof body.liveVoiceTransport === 'string' ? body.liveVoiceTransport : null

      const transport = lastLiveVoiceTransport || ''
      const voiceBrowserExperience = typeof body.voiceBrowserExperience === 'string'
        ? body.voiceBrowserExperience
        : ''
      const blockDirectGoogle = !isRelayWsPath
        && (transport === 'direct_google' || voiceBrowserExperience === 'direct_google_only')
        && !voiceAllowDirectGoogleDevOverride()
      if (blockDirectGoogle) {
        patchLiveUi({ connecting: false, active: false, sessionOpen: false })
        setStatus(
          'Voice needs the chat API on a host with WebSocket relay (not direct browser-to-Google). Text chat still works; deploy chat on ECS/ALB or set localStorage gvp_chat_voice_allow_direct=1 only for debugging.',
          'error',
        )
        trackEvent('chat_live_blocked', { reason: 'direct_google_transport' })
        chatBus.emit('idle', { source: 'chat-live' })
        const err = new Error('direct_google_blocked')
        err.name = 'LiveSetupAbort'
        throw err
      }

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
            stopVoiceInternal({ silent: true })
            if (!ready && !latchRejected) {
              setStatus(closeMsg, 'error')
              trackEvent('chat_live_error', { phase: 'ws_closed_before_ready', code })
              chatBus.emit('error', { source: 'chat-live', message: 'WebSocket closed before ready' })
            }
          }
        })

        await wsOpenPromise
        await setupReadyPromise
        return
      } catch (connectErr) {
        stopVoiceInternal({ silent: true })
        if (isVoiceRetryableSetupFailure(connectErr, isRelayWsPath)
          && connectRound < VOICE_CONNECT_MAX_ROUNDS) {
          continue
        }
        throw connectErr
      }
    }
  }

  /** Get mic permission, build the AudioWorklet (or ScriptProcessor fallback),
   *  and start streaming PCM frames. Assumes the session is already open. */
  const attachMicrophoneInternal = async () => {
    if (active) return
    if (!voiceSessionOpen || !setupDone) throw new Error('voice session not ready')

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1
      },
      video: false
    })

    audioCtx = new AudioContext()
    const inRate = audioCtx.sampleRate
    await audioCtx.resume()

    const sendMicFrame = (floatChannelData) => {
      if (!active || !setupDone || !ws || ws.readyState !== WebSocket.OPEN) return
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
    trackEvent('chat_live_start', {})

    bumpVoiceWsIdleTimer()
    if (!voiceMaxSessionTimer) {
      voiceMaxSessionTimer = setTimeout(() => {
        voiceMaxSessionTimer = null
        if (!voiceSessionOpen) return
        setStatus('Voice session time limit reached. Tap the mic to start again.', 'error')
        trackEvent('chat_live_stop', { reason: 'max_session' })
        stopVoiceInternal({ silent: false })
      }, VOICE_MAX_SESSION_MS)
    }

    mediaSource = audioCtx.createMediaStreamSource(stream)
    mediaSource.connect(processor)
  }

  /** Public: open session and greet. `intent` decides whether the mic is
   *  attached automatically (warm — permission already granted) or whether the
   *  greeting plays first and the visitor has to tap the big mic to attach
   *  (cold — permission not yet granted, or unknown). 'auto' detects via the
   *  Permissions API. */
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

    let resolvedIntent = intent
    if (resolvedIntent === 'auto') {
      const perm = await detectMicPermissionState()
      resolvedIntent = perm === 'granted' ? 'warm' : 'cold'
    }
    sessionIntent = resolvedIntent

    try {
      await openVoiceSessionInternal()

      // Greet only the first time per conversation. Subsequent voice sessions
      // in the same conversation just listen — the visitor already knows what
      // we are and a repeat "Hi, I'm your AI Assistant" mid-thread is grating.
      const shouldGreet = !conversationGreeted
      const greetText = resolvedIntent === 'warm' ? GREETING_TEXT_WARM : GREETING_TEXT_COLD
      greetingTurnComplete = !shouldGreet  // skip the warm follow-up if we didn't greet
      userSpokeAfterGreeting = false
      if (shouldGreet) {
        const greetSent = sendGreetingClientContent(greetText)
        if (!greetSent) {
          throw new Error('Could not send greeting to voice service.')
        }
        conversationGreeted = true
        chatBus.emit('streaming', { source: 'chat-live', model: 'live' })
      }

      if (resolvedIntent === 'warm') {
        // Permission previously granted: attach mic right after greeting starts.
        // The greeting audio plays while we acquire the stream; both end up
        // mixed into the same Web Audio context (mic input is muted to local
        // speakers via the zero-gain node, so there's no feedback loop).
        try {
          await attachMicrophoneInternal()
          setStatus('Listening… speak about Marwan\'s work.')
        } catch (micErr) {
          // Permission "granted" but stream acquisition failed (mic busy, denied,
          // etc.). Fall back to the cold path: session stays open for the
          // greeting; visitor can retry by tapping the big mic.
          sessionIntent = 'cold'
          patchLiveUi({ active: false, connecting: false, sessionOpen: true })
          setStatus(micAccessUserMessage(micErr), 'error')
          scheduleNoMicIdleClose()
        }
      } else {
        // Cold path: greeting plays, no mic. Visitor must tap.
        patchLiveUi({ active: false, connecting: false, sessionOpen: true })
        setStatus('Tap the mic to start talking.')
        scheduleNoMicIdleClose()
      }
    } catch (error) {
      stopVoiceInternal({ silent: true })
      const ename = error instanceof Error ? error.name : ''
      if (ename === 'LiveSetupAbort') {
        return
      }
      let msg = ename === 'LiveSetupFailed' && error instanceof Error
        ? error.message
        : micAccessUserMessage(error)
      if (isVoiceRetryableError(error)) {
        msg = 'Voice could not connect after several tries. The chat API may still be warming up (cold start) or is unreachable — wait a moment and tap the mic again.'
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

    // Cold session is already open (greeting playing / waiting for visitor).
    // Tapping the mic now means "I'm ready, attach the mic."
    if (voiceSessionOpen && setupDone) {
      void attachMicrophone()
      return
    }

    if (voiceConnectInFlight) return

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
    getSessionIntent: () => sessionIntent,
  }
}
