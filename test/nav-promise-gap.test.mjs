import test from 'node:test'
import assert from 'node:assert/strict'

import { hasNavPromiseGap } from '../js/nav-promise-gap.js'

// Did the assistant say it would take the visitor somewhere, and then not?
//
// ADR-0015 §5.2 REJECTED `inferPromisedNavigation` — a heuristic that would have navigated
// the page on the strength of the model's prose — and put this in its place. The reasoning
// is worth keeping next to the code, because the rejected version looks safer than it is:
//
//  1. THE PRECEDENT IS NOT COMPARABLE. `shouldRevealResumeButton` (js/voice-resume-button.js)
//     fires a REVEAL: it adds a button the visitor may ignore, and its worst case is a
//     redundant button. Navigation MOVES THE VISITOR'S PAGE. Its worst case is hijacking
//     someone mid-paragraph because the model said the word "portfolio".
//
//  2. IT IS UNFALSIFIABLE IN THE DIRECTION THAT MATTERS. The navigation version would have
//     to separate "let me take you to the portfolio" from "his portfolio covers fifteen
//     years". MEASURED: the team already had to hand-write that negative for the EASIER
//     problem — test/voice-resume-button.test.mjs:37 pins that "His resume covers fifteen
//     years of work." must NOT reveal. The two-token heuristic barely survives the easy case.
//
//  3. IT FIXES THE WRONG LAYER. §9 pinned five MECHANICAL causes of "confirmed but never
//     executed", every one deterministic and closed by code in this milestone. A prose
//     heuristic on top would mask whatever residue remains and make the journey suite pass
//     for the wrong reason.
//
// SO THIS COUNTER IS RECORDED AND NEVER ACTED ON, and that is what frees the predicate to be
// loose. It triggers nothing, moves nothing, and costs a visitor nothing when it is wrong.
// If the number is non-trivial on real traffic after M2, THAT is the evidence for revisiting
// — a safety net justified by a measurement is a different decision from one justified by a
// transcript, and it would supersede the ADR when it comes.

test('a promise with no navigation is the gap', () => {
  assert.equal(hasNavPromiseGap('Sure — let me take you to the portfolio.', []), true)
  assert.equal(hasNavPromiseGap("I'll show you the labs page now.", []), true)
  assert.equal(hasNavPromiseGap('Taking you there now.', []), true)
})

test('a promise the model KEPT is not a gap', () => {
  assert.equal(
    hasNavPromiseGap('Sure — let me take you to the portfolio.',
      [{ name: 'navigate_to_section', args: { section: 'portfolio' } }]),
    false,
    'the tool ran, so the promise was kept. Counting it would make the number measure ' +
    'how often the assistant offers to navigate, which is not the question'
  )
})

test('merely MENTIONING a section is not a promise', () => {
  // The negative the rejected heuristic could not hold, written out. This predicate may be
  // loose, but a counter that fires on every sentence containing "portfolio" measures
  // nothing at all.
  const notPromises = [
    'His portfolio covers fifteen years of production systems.',
    'The labs page has some of his experiments on it.',
    'He worked on the portfolio site itself, actually.',
    'There are three projects in the portfolio section.'
  ]
  for (const said of notPromises) {
    assert.equal(
      hasNavPromiseGap(said, []), false,
      `${JSON.stringify(said)} describes a section, it does not offer to go there`
    )
  }
})

test('a promise about something other than navigation is not counted', () => {
  assert.equal(
    hasNavPromiseGap("Let me open the contact form for you.", []), false,
    'open_contact_form is a different tool with a different failure mode (§9.3 c1), already ' +
    'closed and already pinned. Folding it in here would blur two counters into one number ' +
    'that answers neither question'
  )
  assert.equal(hasNavPromiseGap("I'll pull up his résumé.", []), false)
})

test('empty or missing input is never a gap', () => {
  for (const said of ['', null, undefined, 0]) {
    assert.equal(hasNavPromiseGap(said, []), false)
  }
  assert.equal(hasNavPromiseGap('let me take you to the portfolio', null), true,
    'a missing tool-call list must be read as "no tools ran", not as a crash')
})

test('the predicate cannot navigate — it only answers a question', () => {
  // The structural half of §5.2's rejection. A module that could move the page would be the
  // rejected design wearing this one's name, and the review that waved it through would be
  // reading a filename.
  const src = hasNavPromiseGap.toString()
  assert.doesNotMatch(
    src, /location|hash|navigate\s*\(|requestNavigation|history/,
    'this is a COUNTER. It is recorded and never acted on, which is the whole reason its ' +
    'predicate is allowed to be loose'
  )
})
