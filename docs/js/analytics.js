export function trackEvent(name, params = {}) {
  if (typeof window.gtag !== 'function') return;

  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value != null && value !== '')
  );

  window.gtag('event', name, cleanParams);
}
