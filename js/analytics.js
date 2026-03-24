// analytics.js - Google Analytics wrapper
export function initAnalytics() {
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-EYTRKC93DL');

  window.gtag = gtag;
}

/** Stable conversion events: resume_click, linkedin_click, email_click (data-conversion on anchor). */
export function initConversionClickTracking() {
  document.addEventListener(
    'click',
    (e) => {
      const link = e.target.closest('a[data-conversion]');
      if (!link || !window.gtag) return;
      const eventName = link.getAttribute('data-conversion');
      if (!eventName) return;
      window.gtag('event', eventName, {
        event_category: 'outbound',
        link_url: link.href,
        transport_type: 'beacon'
      });
    },
    true
  );
}

export function trackClick(event) {
  if (window.gtag && event.target.href) {
    window.gtag('event', 'click', {
      'event_category': 'Link Click',
      'event_label': event.target.href,
      'transport_type': 'beacon'
    });
  }
}

export function trackOutboundClick(eventName, href) {
  if (!window.gtag) return;
  window.gtag('event', eventName, {
    event_category: 'Outbound',
    event_label: href,
    transport_type: 'beacon'
  });
}

export function bindOutboundTracking() {
  document.querySelectorAll('[data-track]').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.getAttribute('data-track');
      const href = el.href || el.getAttribute('href') || '';
      trackOutboundClick(name, href);
    });
  });
}
