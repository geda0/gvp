// The subpage navbar-pill mic is docked inside #agentNode and must open text chat,
// not voice — voice stays one tap away via the "Start voice chat" CTA in the panel.
export function resolveLauncherIntent({ button } = {}) {
  if (button && button.closest('#agentNode')) return 'text'
  return null
}
