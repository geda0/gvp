// M4 slice 14 (ADR-0017 §5.2) — WHEN to attach the microphone, as a function of the permission
// STATE rather than warm/cold. Pure: no navigator, no getUserMedia, no timers.
//
//   granted                      → now: no prompt will appear
//   denied                       → now: getUserMedia fails at once, and deferring a certain
//                                  failure only delays the error the visitor needs to fix it
//   prompt/unknown + greeting    → after the greeting's first turnComplete, with a fallback
//                                  (a modal permission sheet over a speaking assistant cuts it off)
//                                  and a nudge after attach (the cold path had no follow-up nudge,
//                                  so deferring alone would widen its silence gap)
//   prompt/unknown, no greeting  → now: nothing is speaking, nothing to interrupt
// The fallback must stay below chat-live.js's VOICE_SESSION_IDLE_NO_MIC_MS (pinned by test).

export const MIC_DEFER_FALLBACK_MS = 15000

export function micAttachPlan ({ permission, assistantSpeaksFirst } = {}) {
  const promptPossible = permission !== 'granted' && permission !== 'denied'
  if (promptPossible && assistantSpeaksFirst) {
    return { attach: 'after-first-turn', deferFallbackMs: MIC_DEFER_FALLBACK_MS, nudgeAfterAttach: true }
  }
  return { attach: 'now', deferFallbackMs: 0, nudgeAfterAttach: false }
}
