/** Shared modal shell: visibility + Escape-to-close while the dialog is open. */

export function setDialogVisibility(dialog, visible) {
  dialog.hidden = !visible
  dialog.setAttribute('aria-hidden', visible ? 'false' : 'true')
}

/**
 * `ignoreFocusWithin` (ADR-0029 §6.2): a selector to stay out of. While focus is inside it the
 * key belongs to that element (the chat beside a reserved project dialog), so this handler
 * neither closes nor preventDefaults. Omitted, the behaviour is unchanged.
 */
export function bindEscapeClosesDialogWhenOpen(dialog, closeFn, { ignoreFocusWithin } = {}) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dialog.hidden) return
    if (ignoreFocusWithin && document.activeElement?.closest?.(ignoreFocusWithin)) return
    e.preventDefault()
    closeFn()
  })
}
