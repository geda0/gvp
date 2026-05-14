/**
 * Gemini Live (browser WebSocket): mic capture + PCM playback + transcript bubbles.
 */

import { trackEvent } from './analytics.js'
import { chatBus } from './chat-bus.js'

const INPUT_RATE = 16000

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

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function resolveChatApiBase() {
  const raw = window.__CHAT_API_URL__ || ''
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

class PcmJitterPlayer {
  constructor() {
    this.ctx = null
    this.sources = []
    this.scheduledEnd = 0
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
  }

  async enqueue(floats, sampleRate) {
    const ctx = await this.ensure(sampleRate)
    const sr = ctx.sampleRate
    const adjusted = sampleRate === sr ? floats : resampleLinear(floats, sampleRate, sr)
    const buffer = ctx.createBuffer(1, adjusted.length, sr)
    buffer.copyToChannel(adjusted, 0)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const now = ctx.currentTime
    const startAt = Math.max(this.scheduledEnd, now + 0.02)
    src.start(startAt)
    this.sources.push(src)
    src.onended = () => {
      const i = this.sources.indexOf(src)
      if (i >= 0) this.sources.splice(i, 1)
    }
    this.scheduledEnd = startAt + buffer.duration
  }

  close() {
    this.interrupt()
    if (this.ctx) this.ctx.close().catch(() => {})
    this.ctx = null
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
    patchLiveUi
  } = opts

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
  /** Debug: inbound WS JSON messages this voice session (debug session f3789b). */
  let voiceWsMsgCount = 0

  let userBubble = null
  let assistantBubble = null
  let userDraft = ''
  let assistantDraft = ''

  const resetDraftState = () => {
    userBubble = null
    assistantBubble = null
    userDraft = ''
    assistantDraft = ''
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

    voiceSessionOpen = false
    active = false
    voiceWsMsgCount = 0
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
      ws = null
      w.onopen = null
      w.onmessage = null
      w.onerror = null
      w.onclose = null
      if (w.readyState === WebSocket.OPEN) {
        try {
          w.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        } catch (_) {}
        try {
          w.close()
        } catch (_) {}
      }
    }

    player?.close()
    player = null
    setupDone = false

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

    voiceWsMsgCount += 1
    // #region agent log
    if (voiceWsMsgCount <= 5) {
      fetch('http://127.0.0.1:7301/ingest/88d5fa1d-95ae-4b3e-9e2d-4e79fa483fbf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f3789b' },
        body: JSON.stringify({
          sessionId: 'f3789b',
          hypothesisId: 'H2-H4',
          location: 'chat-live.js:handlePayload',
          message: 'ws inbound json',
          data: {
            n: voiceWsMsgCount,
            msgKeys: Object.keys(msg).slice(0, 24),
            hasSetupComplete: !!(msg.setupComplete ?? msg.setup_complete),
            textLen: text.length
          },
          timestamp: Date.now()
        })
      }).catch(() => {})
    }
    // #endregion

    const setupPayload = msg.setupComplete ?? msg.setup_complete
    if (setupPayload) {
      setupDone = true
      chatBus.emit('streaming', { source: 'chat-live', model: 'live' })
    }

    const rootIn = msg.inputTranscription?.text
    const rootOut = msg.outputTranscription?.text
    if (rootIn) patchUserText(rootIn)
    if (rootOut) patchAssistantText(rootOut)

    const sc = msg.serverContent || msg.server_content
    if (sc) {
      if (sc.interrupted) {
        player?.interrupt()
      }

      if (sc.inputTranscription?.text) patchUserText(sc.inputTranscription.text)
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
      }
    }
  }

  const startVoice = async () => {
    if (prefersReducedMotion()) {
      setStatus('Voice mode is disabled when reduced motion is on.', 'error')
      trackEvent('chat_live_blocked', { reason: 'reduced_motion' })
      return
    }

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

    if (voiceConnectInFlight) return
    voiceConnectInFlight = true

    patchLiveUi({ connecting: true, active: false })
    setStatus('Connecting voice…')
    chatBus.emit('thinking', { source: 'chat-live' })

    try {
      const root = resolveChatApiBase().replace(/\/+$/, '')
      const postUrl = `${root}/api/live/session`

      const response = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: getSessionId() })
      })

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
        throw new Error(typeof detail === 'string' && detail.trim()
          ? detail.trim()
          : 'Could not start voice session.')
      }

      const { websocketUrl, handshake, apiVersion, model: modelFromBody } = body
      if (!websocketUrl || !handshake) {
        throw new Error('Voice session response was incomplete.')
      }

      const wsUrlStr = String(websocketUrl)
      const constrainedWs = wsUrlStr.includes('BidiGenerateContentConstrained')
      const modelResource = typeof modelFromBody === 'string' && modelFromBody.trim()
        ? modelFromBody.trim()
        : (modelFromBody != null ? String(modelFromBody) : '')
      const clientSlimsFirstFrame = Boolean(
        constrainedWs
        && modelResource
        && handshake
        && typeof handshake === 'object'
        && handshake.setup
        && typeof handshake.setup === 'object'
        && Object.keys(handshake.setup).length > 1
      )
      const firstClientSetup = clientSlimsFirstFrame
        ? { setup: { model: modelResource } }
        : handshake

      // #region agent log
      fetch('http://127.0.0.1:7301/ingest/88d5fa1d-95ae-4b3e-9e2d-4e79fa483fbf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f3789b' },
        body: JSON.stringify({
          sessionId: 'f3789b',
          hypothesisId: 'H1',
          location: 'chat-live.js:startVoice:afterSessionJson',
          message: 'live session response shape (no url)',
          data: {
            bodyKeys: Object.keys(body),
            apiVersionSibling: typeof apiVersion === 'string' ? apiVersion : null,
            handshakeKeys: handshake && typeof handshake === 'object' ? Object.keys(handshake) : [],
            handshakeHasApiVersion: !!(handshake && typeof handshake === 'object' && handshake.apiVersion),
            setupInnerKeys: handshake?.setup && typeof handshake.setup === 'object'
              ? Object.keys(handshake.setup).slice(0, 40)
              : [],
            clientSlimsFirstFrame,
            constrainedWs,
            wsUrlHasPct2f: wsUrlStr.includes('%2F')
          },
          timestamp: Date.now()
        })
      }).catch(() => {})
      // #endregion

      if (!wsUrlStr.startsWith('wss://')) {
        throw new Error('Invalid voice session URL.')
      }

      voiceSessionOpen = true
      voiceWsMsgCount = 0

      player = new PcmJitterPlayer()

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
          sendMicFrame(event.inputBuffer.getChannelData(0))
        }
        processor.connect(mute)
      }

      ws = new WebSocket(websocketUrl)

      ws.onopen = () => {
        // #region agent log
        const sendObj = firstClientSetup
        const firstSendKeys = sendObj && typeof sendObj === 'object' ? Object.keys(sendObj) : []
        const sentSetupKeys = sendObj?.setup && typeof sendObj.setup === 'object'
          ? Object.keys(sendObj.setup).slice(0, 40)
          : []
        fetch('http://127.0.0.1:7301/ingest/88d5fa1d-95ae-4b3e-9e2d-4e79fa483fbf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f3789b' },
          body: JSON.stringify({
            sessionId: 'f3789b',
            hypothesisId: 'H1',
            location: 'chat-live.js:ws.onopen',
            message: 'first ws send key shape',
            data: {
              firstSendKeys,
              sentSetupKeys,
              includesApiVersionInFrame: firstSendKeys.includes('apiVersion')
            },
            timestamp: Date.now()
          })
        }).catch(() => {})
        // #endregion
        ws.send(JSON.stringify(firstClientSetup))
      }

      ws.onmessage = (ev) => {
        void handlePayload(ev.data)
      }

      ws.onerror = () => {
        setStatus('Voice connection error.', 'error')
        trackEvent('chat_live_error', { phase: 'websocket' })
        chatBus.emit('error', { source: 'chat-live', message: 'WebSocket error' })
      }

      ws.onclose = (ev) => {
        if (!voiceSessionOpen) return
        const ready = setupDone
        const code = ev.code
        const reason = ev.reason
        // #region agent log
        fetch('http://127.0.0.1:7301/ingest/88d5fa1d-95ae-4b3e-9e2d-4e79fa483fbf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'f3789b' },
          body: JSON.stringify({
            sessionId: 'f3789b',
            hypothesisId: 'H1-H3-H5',
            location: 'chat-live.js:ws.onclose',
            message: 'ws closed',
            data: {
              code,
              reason: typeof reason === 'string' ? reason.slice(0, 200) : '',
              setupDoneBeforeClose: ready,
              inboundMsgCount: voiceWsMsgCount
            },
            timestamp: Date.now()
          })
        }).catch(() => {})
        // #endregion
        stopVoiceInternal({ silent: true })
        if (!ready) {
          setStatus(voiceSessionEarlyCloseUserMessage(code, reason), 'error')
          trackEvent('chat_live_error', { phase: 'ws_closed_before_ready', code })
          chatBus.emit('error', { source: 'chat-live', message: 'WebSocket closed before ready' })
        }
      }

      active = true
      syncMicChrome()
      patchLiveUi({ active: true, connecting: false })
      setStatus('Listening… speak about Marwan\'s work.')
      trackEvent('chat_live_start', {})

      mediaSource = audioCtx.createMediaStreamSource(stream)
      mediaSource.connect(processor)
    } catch (error) {
      stopVoiceInternal({ silent: true })
      const msg = micAccessUserMessage(error)
      setStatus(msg, 'error')
      trackEvent('chat_live_error', { phase: 'start', message: msg })
      chatBus.emit('error', { source: 'chat-live', message: msg })
    } finally {
      voiceConnectInFlight = false
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

    if (voiceConnectInFlight) return

    void startVoice()
  }

  for (const btn of micButtons) {
    btn.addEventListener('click', onMicClick)
  }

  syncMicChrome()

  return () => {
    for (const btn of micButtons) {
      delete btn.dataset.gvpChatLiveVoice
      btn.removeEventListener('click', onMicClick)
    }
    stopVoiceInternal({ silent: true })
  }
}
