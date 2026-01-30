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
