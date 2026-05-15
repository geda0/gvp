/** Shared modal shell: visibility + Escape-to-close while the dialog is open. */

export function setDialogVisibility(dialog, visible) {
  dialog.hidden = !visible
  dialog.setAttribute('aria-hidden', visible ? 'false' : 'true')
}

export function bindEscapeClosesDialogWhenOpen(dialog, closeFn) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dialog.hidden) return
    e.preventDefault()
    closeFn()
  })
}
