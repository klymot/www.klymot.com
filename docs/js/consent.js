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

// Beacon the GA consent status as a synthetic path so the self-hosted tracker
// can show a consent breakdown without needing any backend changes.
function beaconConsent(status) {
  const payload = JSON.stringify({ path: `/__consent__/${status}`, referrer: '' });
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
    beaconConsent('accepted');
    return;
  }

  if (stored === 'declined') {
    beaconConsent('declined');
    return;
  }

  // No decision yet — banner is about to be shown.
  beaconConsent('pending');

  const banner = document.getElementById('cookie-banner');
  if (!banner) return;
  banner.hidden = false;

  document.getElementById('cookie-accept')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    banner.hidden = true;
    loadGA();
    beaconConsent('accepted');
  });

  document.getElementById('cookie-decline')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'declined');
    banner.hidden = true;
    beaconConsent('declined');
  });
}
