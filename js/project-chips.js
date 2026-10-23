// M4 slice 13 (ADR-0017 §7.5) — the project chips' canned prompts, as data.
// They carry NO visitor text: the project title comes from the store and the wording from this
// fixed table, which is why the chips may submit directly (unlike selection offers, §7.2).

export const PROJECT_CHIPS = [
  { id: 'summarize', label: 'Summarize', prompt: (title) => `Summarize ${title} for me in a few sentences.` },
  { id: 'more', label: 'Tell me more', prompt: (title) => `Tell me more about ${title} — what was hard about it, and what did Marwan do?` },
  { id: 'talk', label: 'Just talk about it', prompt: (title) => `Let's talk about ${title}.` }
]

export function projectChipPrompt (chipId, title) {
  const chip = PROJECT_CHIPS.find((c) => c.id === chipId)
  const name = typeof title === 'string' ? title.trim() : ''
  if (!chip || !name) return ''
  return chip.prompt(name)
}
