const CONSENT_KEY = 'meridian-consent';
const GA_ID = 'G-CEQZZXVE7Q';

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

export function initConsent() {
  const stored = localStorage.getItem(CONSENT_KEY);

  if (stored === 'accepted') {
    loadGA();
    return;
  }

  if (stored === 'declined') return;

  const banner = document.getElementById('cookie-banner');
  if (!banner) return;
  banner.hidden = false;

  document.getElementById('cookie-accept')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'accepted');
    banner.hidden = true;
    loadGA();
  });

  document.getElementById('cookie-decline')?.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'declined');
    banner.hidden = true;
  });
}
