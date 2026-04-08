export function initContactForm() {
  const openBtn = document.getElementById('openContactBtn')
  const dialog = document.getElementById('contactDialog')
  const closeBtn = dialog?.querySelector('.contact-dialog__close')
  const backdrop = dialog?.querySelector('.contact-dialog__backdrop')
  const form = document.getElementById('contactForm')
  const status = document.getElementById('contactStatus')
  if (!dialog || !form || !status) return

  let lastFocus = null

  const openDialog = () => {
    lastFocus = document.activeElement
    dialog.hidden = false
    dialog.setAttribute('aria-hidden', 'false')
    document.body.classList.add('contact-dialog-open')
    ;(form.querySelector('input[name="name"]') || form.querySelector('input[name="email"]'))?.focus()
  }

  const closeDialog = () => {
    dialog.hidden = true
    dialog.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('contact-dialog-open')
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus()
    }
    lastFocus = null
  }

  openBtn?.addEventListener('click', openDialog)
  closeBtn?.addEventListener('click', closeDialog)
  backdrop?.addEventListener('click', closeDialog)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dialog.hidden) return
    e.preventDefault()
    closeDialog()
  })

  const setStatus = (text, tone = 'muted') => {
    status.textContent = text
    status.dataset.tone = tone
  }

  const setBusy = (busy) => {
    form.querySelectorAll('input, textarea, button').forEach((el) => {
      el.disabled = busy
    })
  }

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
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = body?.error || 'Delivery failed. Try again.'
        setStatus(msg, 'error')
        return
      }

      // Success only means persisted server-side. Delivery may be immediate or queued.
      if (body?.delivery === 'delivered') {
        setStatus('Sent.', 'success')
      } else {
        setStatus('Saved. Delivery in progress.', 'success')
      }

      form.reset()
      closeDialog()
    } catch (_) {
      setStatus('Network error. Try again.', 'error')
    } finally {
      setBusy(false)
    }
  })
}

