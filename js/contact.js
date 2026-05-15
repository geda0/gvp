import { contactApiUrl } from './site-config.js'
import { bindEscapeClosesDialogWhenOpen, setDialogVisibility } from './dialog-helpers.js'

/** Assigned in initContactForm; opens #contactDialog without synthetic button click. */
let openContactDialogImpl = () => {}

export function openContactDialog() {
  openContactDialogImpl()
}

export function initContactForm() {
  const CONTACT_HELPER_TEXT = ''
  const CONTACT_SUCCESS_TEXT = 'Got it — your message is on its way. I\'ll be in touch.'
  const openBtn = document.getElementById('openContactBtn')
  const dialog = document.getElementById('contactDialog')
  const closeBtn = dialog?.querySelector('.contact-dialog__close')
  const backdrop = dialog?.querySelector('.contact-dialog__backdrop')
  const form = document.getElementById('contactForm')
  const status = document.getElementById('contactStatus')
  const successView = document.getElementById('contactSuccessView')
  const successText = document.getElementById('contactSuccessText')
  const sendAnotherBtn = document.getElementById('contactSendAnotherBtn')
  const closeAfterSendBtn = document.getElementById('contactCloseBtn')
  if (!dialog || !form || !status || !successView || !successText || !sendAnotherBtn || !closeAfterSendBtn) return

  let lastFocus = null
  const contactEndpoint = contactApiUrl || '/api/contact'

  const showFormView = (visible) => {
    form.hidden = !visible
    successView.hidden = visible
  }

  const setSuccessView = (text) => {
    successText.textContent = text
    showFormView(false)
  }

  const setStatus = (text, tone = 'muted') => {
    status.textContent = text
    status.dataset.tone = tone
  }

  const setBusy = (busy) => {
    form.querySelectorAll('input, textarea, button').forEach((el) => {
      el.disabled = busy
    })
  }

  // Defensive reset in case browser/cache restored prior DOM state.
  showFormView(true)
  setStatus(CONTACT_HELPER_TEXT, 'muted')

  const openDialog = () => {
    lastFocus = document.activeElement
    setDialogVisibility(dialog, true)
    document.body.classList.add('contact-dialog-open')
    window.dispatchEvent(new CustomEvent('gvp:site-chat-collapse'))
    showFormView(true)
    ;(form.querySelector('input[name="name"]') || form.querySelector('input[name="email"]'))?.focus()
  }

  openContactDialogImpl = openDialog

  const closeDialog = () => {
    setDialogVisibility(dialog, false)
    document.body.classList.remove('contact-dialog-open')
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus()
    }
    lastFocus = null
  }

  openBtn?.addEventListener('click', openDialog)
  closeBtn?.addEventListener('click', closeDialog)
  backdrop?.addEventListener('click', closeDialog)
  sendAnotherBtn.addEventListener('click', () => {
    form.reset()
    setStatus(CONTACT_HELPER_TEXT, 'muted')
    showFormView(true)
    ;(form.querySelector('input[name="name"]') || form.querySelector('input[name="email"]'))?.focus()
  })
  closeAfterSendBtn.addEventListener('click', closeDialog)
  bindEscapeClosesDialogWhenOpen(dialog, closeDialog)

  form.addEventListener('submit', async (e) => {
    e.preventDefault()

    const fd = new FormData(form)
    const payload = {
      name: String(fd.get('name') || '').trim(),
      email: String(fd.get('email') || '').trim(),
      subject: String(fd.get('subject') || '').trim(),
      message: String(fd.get('message') || '').trim(),
      company: String(fd.get('company') || '').trim() // honeypot
    }

    if (!payload.email || !payload.message) {
      setStatus('Email and message are required.', 'error')
      return
    }

    setBusy(true)
    setStatus('Sending…', 'muted')

    try {
      const res = await fetch(contactEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      // Backend may return HTML (e.g. a gateway/proxy error page) instead of JSON.
      // Only parse JSON when the response advertises it; avoid surfacing non-JSON bodies.
      const contentType = res.headers.get('content-type') || ''
      const wantsJson = contentType.includes('application/json')
      let body = {}
      if (wantsJson) {
        try {
          body = await res.json()
        } catch (_) {
          body = null
        }
      }

      if (!res.ok) {
        let msg = body && typeof body === 'object' ? body.error : undefined
        if (typeof msg !== 'string' || !msg.trim()) {
          if (body === null) {
            msg = 'The contact service returned an unexpected reply. Try again in a moment.'
          } else if (res.status >= 400 && res.status < 500) {
            msg = 'Please check your details and try again.'
          } else {
            msg = 'The server had a problem. Try again in a moment.'
          }
        }
        setStatus(msg, 'error')
        return
      }

      if (body === null || typeof body !== 'object') {
        setStatus('The contact service returned an unexpected reply. Try again.', 'error')
        return
      }
      if (!wantsJson) {
        setStatus('The contact service returned an unexpected reply. Try again.', 'error')
        return
      }

      // Success only means persisted server-side. Delivery may be immediate or queued.
      setStatus(CONTACT_SUCCESS_TEXT, 'success')
      setSuccessView(CONTACT_SUCCESS_TEXT)

      form.reset()
    } catch (_) {
      setStatus('Network error. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  })
}

