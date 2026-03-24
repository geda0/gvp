// analytics.js - Google Analytics wrapper
export function initAnalytics() {
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-EYTRKC93DL');

  window.gtag = gtag;
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
