// M4 slice 14 (ADR-0017 §5.2): WHEN to attach the microphone. A function of the permission
// STATE, not of warm/cold — today's warm/cold split folds `denied` in with `prompt`, and those
// need opposite treatment. Pure: no navigator, no getUserMedia, no timers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { micAttachPlan } from '../js/mic-attach-plan.js'

test('granted: no prompt will appear, so attach now', () => {
  for (const assistantSpeaksFirst of [true, false]) {
    assert.deepEqual(micAttachPlan({ permission: 'granted', assistantSpeaksFirst }), { attach: 'now', deferFallbackMs: 0, nudgeAfterAttach: false })
  }
})

test('denied: attach now — deferring a certain failure only delays the error the visitor needs', () => {
  for (const assistantSpeaksFirst of [true, false]) {
    assert.equal(micAttachPlan({ permission: 'denied', assistantSpeaksFirst }).attach, 'now')
  }
})

test('prompt/unknown with a greeting: defer until the first turnComplete, with a fallback and a nudge', () => {
  for (const permission of ['prompt', 'unknown']) {
    const plan = micAttachPlan({ permission, assistantSpeaksFirst: true })
    assert.equal(plan.attach, 'after-first-turn')
    assert.ok(plan.deferFallbackMs > 0)
    assert.equal(plan.nudgeAfterAttach, true, 'closes the cold-path silence gap instead of widening it')
  }
})

test('prompt/unknown with nothing speaking (a second session does not greet): attach now', () => {
  for (const permission of ['prompt', 'unknown']) {
    assert.equal(micAttachPlan({ permission, assistantSpeaksFirst: false }).attach, 'now')
  }
})

test('an unexpected permission value is treated as unknown, never as granted', () => {
  assert.equal(micAttachPlan({ permission: 'weird', assistantSpeaksFirst: true }).attach, 'after-first-turn')
})

test('the deferred fallback fires before the 60 s no-mic sweep closes the session', () => {
  const src = readFileSync(new URL('../js/chat-live.js', import.meta.url), 'utf8')
  const m = src.match(/VOICE_SESSION_IDLE_NO_MIC_MS\s*=\s*([\d\s*]+)/)
  assert.ok(m, 'VOICE_SESSION_IDLE_NO_MIC_MS not found in js/chat-live.js')
  const idle = Function(`return (${m[1]})`)()
  const { deferFallbackMs } = micAttachPlan({ permission: 'prompt', assistantSpeaksFirst: true })
  assert.ok(deferFallbackMs < idle, `fallback ${deferFallbackMs} must be shorter than the sweep ${idle}`)
})
