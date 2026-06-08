const CONSENT_KEY = 'klymot-consent';
const GA_ID = 'G-JRMHRKGT89';

function loadGA() {
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_ID);
}

// Send a fire-and-forget usage beacon without importing the full analytics module
// (consent.js loads before the module graph is resolved).
function beaconConsent(status) {
  const payload = JSON.stringify({ path: '/__consent__', referrer: status });
  const blob = new Blob([payload], { type: 'text/plain' });
  const url = 'https://api.klymot.com/api/v1/usage';
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, blob);
  } else {
    fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }
}

export function initConsent() {
  const stored = localStorage.getItem(CONSENT_KEY);

  if (stored === 'accepted') {
    loadGA();
    beaconConsent('ga:accepted');
    return;
  }

  if (stored === 'declined') {
    beaconConsent('ga:declined');
    return;
  }

  // No decision recorded yet — beacon that the banner was shown.
  beaconConsent('ga:pending');

  const banner = document.getElementById('cookie-banner');
  if (!banner) return;
  banner.hidden = false;

  document.getElementById('cookie-accept')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    banner.hidden = true;
    loadGA();
    beaconConsent('ga:accepted');
  });

  document.getElementById('cookie-decline')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'declined');
    banner.hidden = true;
    beaconConsent('ga:declined');
  });
}
