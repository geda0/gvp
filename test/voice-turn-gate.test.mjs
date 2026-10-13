import test from 'node:test'
import assert from 'node:assert/strict'
import { freshTurnGate, nextTurnGate, acceptsTurnOutput } from '../js/voice-turn-gate.js'

// When the visitor interrupts the voice greeting, does the interrupted turn actually DIE?
//
// Reported on prod with a screenshot (2026-10-13). Interrupting the greeting broke three
// ways at once, and all three are one cause:
//   1. the greeting text kept arriving, SPLIT ACROSS MULTIPLE assistant bubbles;
//   2. the greeting AUDIO kept playing (the owner read it as "it lags");
//   3. the visitor's actual question was never answered.
//
// The one cause: `serverContent.interrupted` was handled as a ONE-SHOT FLUSH, not as a
// cancellation. `player.interrupt()` correctly stopped every queued source and rewound
// `scheduledEnd` to `currentTime` — and then the pipe REOPENED. Nothing recorded that the
// turn was dead, so everything the server flushed afterwards FOR THAT SAME CANCELLED TURN
// was accepted: late PCM chunks got scheduled from the rewound cursor (symptom 2), late
// transcription kept appending (symptom 1), and because `turnComplete` finalized the turn
// and nulled the bubble, the NEXT straggler opened a BRAND-NEW bubble — one bubble per
// straggler batch, which is literally what the screenshot shows.
//
// So the gate is a TURN EPOCH, not a flush: `interrupted` marks the current turn cancelled
// and its whole tail — audio AND text — is dropped; `turnComplete` is the turn BOUNDARY
// (the cancelled turn's tail all arrives before it), so the gate re-opens there and the
// NEXT turn flows normally. Both halves are load-bearing in opposite directions: a gate
// that only dropped the first late fragment is the shipped bug again, and a gate that
// latched shut forever would silence every later reply — which is symptom 3 made permanent.
//
// Pure module, by the `js/voice-resume-button.js` precedent: no DOM, no AudioContext, no
// WebSocket. The state is OPAQUE on purpose — this test only ever asks the predicate,
// never inspects a field, so the gate can be a flag, an epoch counter, or a tagged union.

test('an interrupted turn drops its whole tail, and the gate re-opens for the next turn', () => {
  // Arrange — the exact prod sequence: greeting speaking, visitor cuts in, server keeps
  // flushing the dead greeting, then the real answer turn starts.
  const greeting = freshTurnGate()

  // Act
  const cancelled = nextTurnGate(greeting, 'interrupted')
  const reopened = nextTurnGate(cancelled, 'turnComplete')

  const decisions = {
    // The greeting itself: nothing cancelled, so it plays and renders.
    greetingOutput: acceptsTurnOutput(greeting),
    // Symptoms 1 + 2: the first straggler after `interrupted`. Dropped, so no late audio
    // is scheduled and no second bubble can be opened for it.
    cancelledTailFirstFragment: acceptsTurnOutput(cancelled),
    // Still the same cancelled turn, still before its `turnComplete`. This is the one-shot
    // flush trap: dropping only the FIRST straggler is the shipped bug wearing a gate.
    cancelledTailLaterFragment: acceptsTurnOutput(cancelled),
    // Symptom 3: after the boundary the visitor's question must be answerable. A gate that
    // latched shut would silence every reply from here on.
    nextTurnOutput: acceptsTurnOutput(reopened),
  }

  // Assert
  assert.deepEqual(
    decisions,
    {
      greetingOutput: true,
      cancelledTailFirstFragment: false,
      cancelledTailLaterFragment: false,
      nextTurnOutput: true,
    },
    'the interrupted turn must be CANCELLED (its whole tail dropped — that is the three ' +
    'bubbles and the audio that kept playing) and the gate must RE-OPEN at turnComplete ' +
    "(or the visitor's question is never answered)",
  )
})
