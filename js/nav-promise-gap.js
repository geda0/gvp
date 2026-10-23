/**
 * Pure predicate: did the assistant OFFER to move the visitor, and then not move them?
 *
 * ADR-0015 §5.2 rejected `inferPromisedNavigation` — a heuristic that would have navigated
 * the page on the strength of the model's prose — and put this counter in its place. Three
 * reasons, kept here because the rejected design looks safer than it is:
 *
 *  1. The precedent is not comparable. `shouldRevealResumeButton` fires a REVEAL: it adds a
 *     button the visitor may ignore, worst case a redundant button. Navigation MOVES THE
 *     VISITOR'S PAGE, worst case hijacking someone mid-paragraph because the model said the
 *     word "portfolio".
 *  2. It is unfalsifiable in the direction that matters: "let me take you to the portfolio"
 *     versus "his portfolio covers fifteen years". The team already had to hand-write that
 *     negative for the EASIER résumé problem, and that two-token heuristic barely survives
 *     its own easy case.
 *  3. It fixes the wrong layer. §9 pinned five mechanical causes of "confirmed but never
 *     executed", every one deterministic and closed in this milestone; a prose heuristic on
 *     top would mask the residue and make the journey suite pass for the wrong reason.
 *
 * SO THIS IS RECORDED AND NEVER ACTED ON. Nothing moves when it fires, which is exactly what
 * lets the predicate be loose. If the count is non-trivial on real traffic after M2, that
 * measurement is the evidence for revisiting — and a safety net justified by a number is a
 * different decision from one justified by a transcript.
 *
 * @param {unknown} assistantText finished assistant speech or reply text
 * @param {Array<{name?: string}>|null} [toolCalls] tool calls made this turn
 * @returns {boolean}
 */
export function hasNavPromiseGap (assistantText, toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  // The promise was kept. Counting it would turn this into a measure of how often the
  // assistant offers to navigate, which is not the question.
  if (calls.some((t) => t && t.name === 'navigate_to_section')) return false

  const said = String(assistantText || '')
  if (!said) return false

  // A FIRST-PERSON OFFER TO MOVE, not a mention of a place. The loose half is deliberate;
  // this half is not, because a counter that fires on every sentence containing the word
  // "portfolio" measures nothing.
  const offersToMove = /\b(?:let me (?:take|bring|show)|i'?ll (?:take|bring|show|open)|taking you|bringing you|i'?m taking you|here you go)\b/i
    .test(said)
  if (!offersToMove) return false

  // ...and the destination has to be a PAGE. open_contact_form and open_resume have their
  // own, already-closed failure modes (§9.3 c1); folding them in would blur two counters
  // into one number that answers neither question.
  const aPage = /\b(?:portfolio|labs|home ?page|experiments|work)\b|\bthere\b/i.test(said)
  const somethingElse = /\b(?:contact form|r[eé]sum[eé]|\bcv\b)\b/i.test(said)
  return aPage && !somethingElse
}
