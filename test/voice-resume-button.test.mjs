import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRevealResumeButton } from '../js/voice-resume-button.js'

test('promised a résumé button but never called open_resume → reveal it', () => {
  assert.equal(
    shouldRevealResumeButton('Tap the on screen button to open the resume.', []),
    true,
  )
})

test('the model already called open_resume → do NOT double-reveal', () => {
  assert.equal(
    shouldRevealResumeButton('Tap the on screen button to open the resume.', [
      { name: 'open_resume' },
    ]),
    false,
  )
})

test('mentions résumé (accented) + button → reveal', () => {
  assert.equal(
    shouldRevealResumeButton('Here is his résumé — tap the button below.', []),
    true,
  )
})

test('mentions a button but not the résumé → do NOT fire (avoid false positives)', () => {
  assert.equal(
    shouldRevealResumeButton('Tap the button to start the tour.', []),
    false,
  )
})

test('talks about the résumé but offers no button → nothing to back, do not fire', () => {
  assert.equal(
    shouldRevealResumeButton('His resume covers fifteen years of work.', []),
    false,
  )
})

test('navigate turn (no button, no résumé) → do not fire', () => {
  assert.equal(
    shouldRevealResumeButton('Let me take you to the portfolio.', [
      { name: 'navigate_to_section' },
    ]),
    false,
  )
})

test('CV phrasing counts as résumé intent', () => {
  assert.equal(shouldRevealResumeButton('Tap the button for his CV.', []), true)
})

test('empty / nullish inputs are safe and do not fire', () => {
  assert.equal(shouldRevealResumeButton('', []), false)
  assert.equal(shouldRevealResumeButton(null), false)
  assert.equal(shouldRevealResumeButton(undefined, undefined), false)
})
