const GA_ID = 'G-JRMHRKGT89';
const API_BASE = 'https://api.klymot.com';

// Passive beacon — fires for all visitors regardless of GA consent.
// Never stores raw IP or UA; the server derives only country code,
// browser family and OS family, then discards the originals.
function sendBeacon(path) {
  if (typeof navigator === 'undefined') return;
  const payload = JSON.stringify({ path, referrer: document.referrer || '' });
  // text/plain is a CORS "simple" request — no preflight, works reliably with sendBeacon.
  // The Go server's json.NewDecoder ignores Content-Type so it still parses fine.
  const blob = new Blob([payload], { type: 'text/plain' });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_BASE + '/api/v1/usage', blob);
  } else {
    fetch(API_BASE + '/api/v1/usage', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }
}

// Fire on page load (SPA calls this manually on route changes too).
sendBeacon(window.location.pathname);

export function trackPageView(path) {
  sendBeacon(path);
}

export function trackEvent(name, params = {}) {
  if (typeof window.gtag !== 'function') return;

  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value != null && value !== '')
  );

  window.gtag('event', name, cleanParams);
}
