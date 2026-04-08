/**
 * LinkedIn job → job-agent capture (bookmarklet body).
 * Minify for bookmark bar; set API_KEY and BASE (e.g. http://127.0.0.1:8080).
 */
;(function () {
  var API_KEY = 'YOUR_API_KEY'
  var BASE = 'http://127.0.0.1:8080'
  var u = location.href
  var t =
    (document.querySelector('h1') && document.querySelector('h1').innerText) ||
    document.title
  var c =
    (document.querySelector('[data-test-job-details-company-name]') &&
      document.querySelector('[data-test-job-details-company-name]').innerText) ||
    (document.querySelector('.jobs-unified-top-card__company-name a') &&
      document.querySelector('.jobs-unified-top-card__company-name a').innerText) ||
    ''
  fetch(BASE + '/api/linkedin/capture', {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({
      url: u,
      title: (t || '').slice(0, 1000),
      company: (c || '').slice(0, 500),
      snippet: '',
    }),
  })
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.detail || r.statusText)
        return j
      })
    })
    .then(function (d) {
      alert('Saved job posting id ' + d.job_posting_id + ' (score ' + (d.match_score != null ? d.match_score : '?') + ')')
    })
    .catch(function (e) {
      alert('Capture failed: ' + e.message)
    })
})()
