/**
 * Pure predicate: should the FE reveal the résumé download button as a safety net?
 *
 * The voice (Gemini Live) model sometimes SPEAKS "tap the on-screen button" for
 * the résumé without actually calling the open_resume tool, leaving the promise
 * with no button. Given a finished turn's assistant speech + the tool calls it
 * made, this decides whether to reveal the button so the words are always backed
 * by one. Dependency-free so it is trivially unit-testable.
 *
 * @param {unknown} assistantText  the finished assistant speech transcript
 * @param {Array<{name?: string}>} [toolCalls]  tool calls made this turn
 * @returns {boolean}
 */
export function shouldRevealResumeButton(assistantText, toolCalls = []) {
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  // Already backed by a button — the model called the tool; don't double-reveal.
  if (calls.some((t) => t && t.name === 'open_resume')) return false
  const said = String(assistantText || '')
  const mentionsButton = /\bbutton\b/i.test(said)
  const mentionsResume = /r[eé]sum[eé]|\bresume\b|\bcv\b/i.test(said)
  return mentionsButton && mentionsResume
}
