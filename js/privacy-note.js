// M8 item 5 (ADR-0021 D4) — a plain-words privacy note opened from the SITE footer.
// It may only say what the code does: the retention numbers below are pinned to the
// constants that enforce them (test/privacy-note.test.mjs), and the facts were verified
// against the code on 2026-10-23.
import { bindEscapeClosesDialogWhenOpen, setDialogVisibility } from './dialog-helpers.js'

// docker/chat/app/transcript_store.py _DEFAULT_TTL_DAYS
export const TRANSCRIPT_RETENTION_DAYS = 180
// aws/src/common/events-shared.js EVENT_TTL_DAYS
export const EVENT_RETENTION_DAYS = 120

export function privacyFacts() {
  return [
    'Chat and voice conversations are answered by Google Gemini, so what you type or say is sent to Google to produce a reply.',
    `This site keeps the text of each conversation so it can be reviewed and improved. New conversations are deleted about ${TRANSCRIPT_RETENTION_DAYS} days after their last message; older conversations, from before that rule existed, are still kept.`,
    'Voice chat stores no audio. The words of a voice conversation are kept as written text, the same as a typed chat.',
    'Your microphone is used only while voice chat is on, and released when it ends.',
    `This site records simple page events (which section you opened, whether chat worked) with your IP address scrambled by a keyed hash. Those records are deleted after ${EVENT_RETENTION_DAYS} days.`,
    'Google Analytics also runs on this site and, like on most sites, it sees your IP address.',
    'Messages you send through the contact form are kept so they can be answered, with no set deletion date.'
  ]
}

export function initPrivacyNote() {
  const openBtn = document.getElementById('footerOpenPrivacyBtn')
  const dialog = document.getElementById('privacyDialog')
  const list = document.getElementById('privacyFacts')
  if (!openBtn || !dialog || !list) return

  for (const fact of privacyFacts()) {
    const li = document.createElement('li')
    li.textContent = fact
    list.appendChild(li)
  }

  let lastFocus = null
  const close = () => {
    setDialogVisibility(dialog, false)
    document.body.classList.remove('privacy-dialog-open')
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus()
    lastFocus = null
  }
  const open = () => {
    lastFocus = document.activeElement
    setDialogVisibility(dialog, true)
    document.body.classList.add('privacy-dialog-open')
    dialog.querySelector('.contact-dialog__close')?.focus()
  }

  openBtn.addEventListener('click', open)
  dialog.querySelector('.contact-dialog__close')?.addEventListener('click', close)
  dialog.querySelector('.contact-dialog__backdrop')?.addEventListener('click', close)
  bindEscapeClosesDialogWhenOpen(dialog, close)
}
