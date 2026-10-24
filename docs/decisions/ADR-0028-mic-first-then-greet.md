# ADR-0028 — Mic first, then greet: on the cold path the greeting waits for the permission grant

- **Status:** **Accepted (contract only — no code written by this ADR).** The seams below are what
  the test-writer builds failing tests against.
- **Date:** 2026-10-24
- **Source:** orchestrator RCA (2026-10-24) of the first-visit voice start: the browser's
  permission bubble opens over the speaking greeting, the visitor reads it while the assistant
  talks, the echo canceller starts cold mid-sentence, and a dismissed bubble is reported with the
  "denied" copy (the visitor never denied anything).
- **Supersedes:** ADR-0026 **§2, the paragraph "The accepted cost"** — *"on a first visit the
  browser's permission sheet appears over the speaking greeting"*. The rest of ADR-0026 §2
  (`micAttachPlan` deleted, no deferral behind `turnComplete`, `denied` reaching `getUserMedia` at
  once, the `VOICE_SESSION_IDLE_NO_MIC_MS` sweep) **stands**. ADR-0026 §2 itself demanded what this
  ADR supplies: *"a different, measured route to barge-in **and** #25 kept green"* — the route is
  "the mic is live before the greeting's first audio", which is strictly earlier than ADR-0026's.
- **Amends:** invariant **#25** (*Voice* clause) in `docs/tdd/project-invariants.md`.
- **Unchanged:** the warm path (`perm === 'granted'`), the `denied` path (`perm === 'denied'`), the
  c841477 rule (a mic tap while the permission bubble is open ends the call), invariants #20 / #25's
  one-door rule.
- **Seam owner:** architect. **Implemented by:** the loop (test first).

---

## 1. Context

`startVoice` (`js/chat-live.js` ~1405) today, on every path: `detectMicPermissionState()` →
`await openVoiceSessionInternal()` → `sendGreetingClientContent()` → `await
attachMicrophoneInternal()`. On a cold path (`'prompt'` / `'unknown'`) the `getUserMedia` call is
therefore made **after** the greeting is sent, so the bubble appears while the greeting plays.
Three measured consequences:

1. The visitor has to read and decide on a browser sheet while being spoken to.
2. The mic, when granted, joins mid-greeting: the AEC adapts against a signal that is already
   playing, which is the worst case for the greeting-tail echo the ADR-0026 addendum had to guard.
3. A **dismissed** bubble (closed without a choice) rejects `getUserMedia` with `NotAllowedError`
   exactly like a block, so `micAccessUserMessage` tells the visitor *"Microphone access was
   denied…"* — false, and it sends them to browser settings for a setting they never changed.

`attachMicrophoneOnce` couples two things that do not need each other: **acquiring** the stream
(`getUserMedia`, needs only the tap's user activation) and **wiring** it (AudioContext, worklet,
`sendMicFrame`, needs `voiceSessionOpen && setupDone`). That coupling is what forces the serial
order.

## 2. DECISION 1 — split acquire from wire

Inside `bindChatLiveVoice` (`js/chat-live.js`), `attachMicrophoneOnce` becomes two closures:

```js
// getUserMedia only. No session precondition. ONE in flight (the M4-critic rule, now on the
// acquire): every caller shares `micAcquireInFlight`.
const acquireMicStream = () => Promise<MediaStream>

// The existing pipeline (AudioContext, worklet / ScriptProcessor fallback, sendMicFrame,
// active = true, chat_live_start, max-session timer). Requires voiceSessionOpen && setupDone.
// If the session ended before it runs, it stops the stream's tracks and throws (today's
// "allowed after hang-up" rule, unchanged).
const wireMicrophone = async (stream) => { … }
```

`attachMicrophoneInternal()` (the mic-tap and warm/denied paths) stays as
`wireMicrophone(await acquireMicStream())`, keeping its shared `attachInFlight` promise, so the
warm and denied paths are behaviourally unchanged.

## 3. DECISION 2 — the cold path: mic and session in parallel, greeting after the grant

### 3.1 Constants and copy (module scope, `js/chat-live.js`)

```js
/** How long the cold path waits on the permission bubble before closing the Live session.
 *  ONE number with the no-mic sweep: both bound "a Live session open with no mic". */
const VOICE_PERMISSION_WAIT_MS = VOICE_SESSION_IDLE_NO_MIC_MS   // 60 000

const MIC_PERMISSION_HINT =
  'Your browser is asking for the microphone — choose “Allow while visiting the site” so we don\'t ask again.'
const MIC_DISMISSED_MSG =
  'No microphone access yet — tap Start voice chat to be asked again.'
// denied: micAccessUserMessage(err) — the existing NotAllowedError copy, unchanged.
```

`MIC_DISMISSED_MSG` is also the timeout copy: both mean "no answer yet, ask again"; telemetry
(§5) keeps them apart. Exactly these strings; a test asserts them.

### 3.2 The state sequence (`startVoice`, cold branch: `perm` is `'prompt'` or `'unknown'`)

```
tap ─► perm = await detectMicPermissionState()           // as today; also feeds telemetry
     ─► micP     = acquireMicStream()                     // FIRST, same task: bubble opens now
        sessionP = openVoiceSessionInternal()             // in parallel (mint + WS + setup)
        setStatus(MIC_PERMISSION_HINT)                    // only while micP is pending
        permissionWaitTimer = setTimeout(timeout, VOICE_PERMISSION_WAIT_MS)
     ─► await micP  (settles first or second; order does not matter)
        ├─ resolved(stream)  → outcome 'granted'
        │     clear timer; await sessionP; await wireMicrophone(stream)
        │     ─► sendGreetingClientContent(GREETING_TEXT_COLD)  // same continuation, no timer,
        │                                                       // no turnComplete wait
        │     setStatus('Listening… speak about Marwan's work.')
        ├─ rejected NotAllowedError/SecurityError
        │     after = await detectMicPermissionState()
        │     after === 'prompt'  → outcome 'dismissed' → close, MIC_DISMISSED_MSG
        │     otherwise           → outcome 'denied'    → close, micAccessUserMessage(err)
        ├─ rejected other (NotFound / NotReadable / …) → outcome 'error'
        │     → close, micAccessUserMessage(err)  (today's copy)
        └─ timer fires first → outcome 'timeout'
              → close, MIC_DISMISSED_MSG; a late grant is released by wireMicrophone's
                "session ended" guard (the stream's tracks are stopped)
```

- **"close"** = `stopVoiceInternal({ silent: true })` then `setStatus(copy, 'error')`. The Live
  session is closed, the voice pane returns to its start state, and the text composer is usable
  (that is the "text fallback"; no new UI). **No greeting is ever sent** on a non-granted outcome.
- **`'unknown'` after a `NotAllowedError`** (no Permissions API) reads as `denied`, which is
  today's copy. A dismissal is only claimed when the browser *says* the state is still `'prompt'`.
- **Session failure after a grant:** stop the stream's tracks, then today's connect-error path
  (`isVoiceRetryableError` copy etc.). The grant is not wasted: the next tap is warm.
- **Stale-start guard.** Every `await` in the cold branch is followed by a check that this start is
  still current (`voiceSessionOpen`/a start epoch bumped by `stopVoiceInternal`). If the visitor
  ended it, the branch releases any stream and returns **silently** — no greeting, no error copy,
  no no-mic sweep (the same rule the warm branch already has: *"hung up while getUserMedia was
  pending"*).
- **Ending during the wait** (the c841477 rule, extended to the new wait): `onMicClick` treats a
  pending acquire exactly like a pending attach — `trackEvent('chat_live_stop', { reason:
  'abort_mic_prompt' })` + `stopVoiceInternal`. Panel close / hang-up go through `snapClose` →
  `stopVoice` as today. `stopVoiceInternal` clears `permissionWaitTimer`.
- **`voiceConnectInFlight` stays `true` through the wait**, so a second Start tap is still a no-op.

### 3.3 Why this keeps barge-in (#25)

The mic is wired **before** the greeting `clientContent` is sent, so upstream audio exists from
the greeting's first frame and Gemini Live can raise `serverContent.interrupted`; the ADR-0026
addendum's `voice_local` path sees onsets from the greeting's onset. The AEC converges on the
greeting from its first sample instead of mid-sentence. Nothing about `interruptAssistant` or the
turn gate changes.

### 3.4 What stays exactly as it is

- `perm === 'granted'` (warm): open → greet → `attachMicrophoneInternal()` at once, warm greeting,
  warm follow-up nudge.
- `perm === 'denied'`: open → greet → attach fails at once → denied copy, session kept for the
  greeting, `scheduleNoMicIdleClose()`. (The permission is already known blocked; there is no
  bubble to wait on.)
- `sessionIntent` stays `'cold'` after a cold grant (telemetry's `intent` keeps meaning "permission
  state at start"); the follow-up nudge stays warm-only (ADR-0026 §2 scope).
- A later mic tap on an open, mic-less session (`attachMicrophone`) is unchanged.

## 4. Cost, stated

- **The cold greeting starts later** by the visitor's decision time on the bubble (plus nothing
  else: the session mint runs in parallel). That is the point — the visitor is not spoken to while
  being asked something by the browser.
- A Live session can sit open, silent, for up to `VOICE_PERMISSION_WAIT_MS`. Bounded and billed
  the same as today's no-mic sweep window.
- The hint names Chrome's wording ("Allow while visiting the site"); Safari/Firefox phrase it
  differently. Owner copy; kept.

## 5. DECISION 3 — telemetry (no PII, enumerated params only)

| Event | Where | Params |
|---|---|---|
| `chat_voice_start` | moved from `js/chat.js` (the tap) into `startVoice`, right after `detectMicPermissionState()` — one emit per start that reaches the permission read | `{ perm }` |
| `chat_live_start` | `wireMicrophone` (as today) | `{ perm, outcome: 'granted' }` |
| `chat_live_stop` | the cold branch's non-granted exits | `{ reason: 'mic_permission', perm, outcome }` |

- `perm` ∈ `'granted' | 'prompt' | 'denied' | 'unknown'` — the state read at the start.
- `outcome` ∈ `'granted' | 'denied' | 'dismissed' | 'timeout' | 'error'` (`'error'` = a
  non-permission `getUserMedia` failure, added so the enum is total).
- Hang-up during the wait keeps `{ reason: 'abort_mic_prompt' }` (c841477) and carries no
  `outcome` — the visitor ended it, the browser did not answer.
- No error messages, device labels or timings in these params. `aws/src/admin/assistant-usage-core.js`
  keys on event names only, so its funnel is unaffected.

## 6. Pins (test-writer)

Wiring, over the existing fake-socket harness (`test/mic-attach-wiring.test.mjs` /
`test/barge-in-wiring.test.mjs` helpers), with a `getUserMedia` the test resolves or rejects by
hand and a permissions stub whose state the test sets:

1. **Cold `'prompt'` and `'unknown'`:** `getUserMedia` is called **before** the session's
   `setupComplete` is delivered (parallel); while it is pending, **no `clientContent` greeting is
   sent** even after `setupComplete`, and status is exactly `MIC_PERMISSION_HINT`.
2. **Grant:** after resolving `getUserMedia`, within one microtask flush the greeting
   `clientContent` is sent **and** the mic is already active (`isActive()` true / a
   `realtimeInput` frame can be sent before the greeting) — the order *wired → greeting* is
   asserted, not just both.
3. **Grant before `setupComplete`:** the greeting waits for setup, then wire, then greet.
4. **Denied:** `NotAllowedError` with the re-queried state `'denied'` → session closed (socket
   closed), no greeting sent, status = the existing denied copy.
5. **Dismissed:** `NotAllowedError` with the re-queried state still `'prompt'` → session closed,
   no greeting, status exactly `MIC_DISMISSED_MSG` (and **not** the denied copy).
6. **Timeout:** on a fake clock, `VOICE_PERMISSION_WAIT_MS` with `getUserMedia` pending closes the
   session, sends no greeting, shows `MIC_DISMISSED_MSG`; a grant arriving afterwards stops the
   stream's tracks and sends nothing.
7. **Hang-up during the wait:** a mic tap (and separately `stopVoice`) while `getUserMedia` is
   pending closes the session at once with `abort_mic_prompt`; the later grant sends no greeting
   and its tracks are stopped; no error copy.
8. **Unchanged rows stay green:** granted → greet then attach; denied → attach at once, error copy,
   no-mic sweep armed; one `getUserMedia` per start even with a concurrent mic tap.
9. **Telemetry:** `chat_voice_start {perm}`; `chat_live_start {perm, outcome:'granted'}`;
   `chat_live_stop {reason:'mic_permission', perm, outcome}` for each of denied / dismissed /
   timeout / error; params are exactly these keys.
10. **Constant relation:** `VOICE_PERMISSION_WAIT_MS === VOICE_SESSION_IDLE_NO_MIC_MS` (source
    assertion), so the two windows cannot drift apart.

`[qa]` `scripts/qa/voice-stage-probe.mjs`: on the cold path (fake device + a permission the probe
grants after a delay), the first greeting audio arrives **after** the mic's first upstream frame,
and #25's "interrupted before greeting completes" assertion still holds.

## 7. Consequences

- Invariant **#25**'s *Voice* clause changes from "attached right after the greeting is sent" to
  "live **no later than** the greeting is sent; on the cold path the greeting waits for the grant"
  and loses "the permission sheet over the greeting is the accepted cost".
- `test/mic-attach-wiring.test.mjs`'s cold rows ("requested at once, before the greeting's
  turnComplete") stay true and gain the stronger "greeting not before grant" rows above.
- Drift noted, not fixed: none.
