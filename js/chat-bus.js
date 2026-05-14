const listeners = new Set()

let currentState = 'idle'
let currentDetail = {}

/** Shared section-name normalization used by chat.js and agent-node.js. */
export function normalizeSection(section) {
  return section === 'playground' || section === 'portfolio' ? section : 'home'
}

function normalizeState(state) {
  const raw = String(state || '').trim().toLowerCase()
  if (!raw) return 'idle'
  return raw
}

export const chatBus = {
  emit(state, detail = {}) {
    currentState = normalizeState(state)
    currentDetail = detail && typeof detail === 'object' ? detail : {}
    listeners.forEach((listener) => listener(currentState, currentDetail))
  },
  on(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    listener(currentState, currentDetail)
    return () => {
      listeners.delete(listener)
    }
  },
  getState() {
    return { state: currentState, detail: currentDetail }
  }
}
