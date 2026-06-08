const GA_ID = 'G-JRMHRKGT89';
const API_BASE = 'https://api.klymot.com';

// Passive beacon — always fires regardless of GA consent.
// Never stores raw IP or UA; the server derives only country code,
// browser family and OS family, then discards the originals.
function _beacon(path) {
  if (typeof navigator === 'undefined') return;
  const payload = JSON.stringify({ path, referrer: document.referrer || '' });
  // text/plain = CORS simple request, no preflight, works reliably with sendBeacon.
  const blob = new Blob([payload], { type: 'text/plain' });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API_BASE + '/api/v1/usage', blob);
  } else {
    fetch(API_BASE + '/api/v1/usage', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }
}

// Map each trackable event name to the synthetic path it beacons.
// Events not listed here are sent to GA only (if consented).
const _FEATURE_PATH = {
  view_mode_change:    p => `/__feature__/view-${p.to_view    || 'unknown'}`,
  detail_open:         _  => '/__feature__/station-detail',
  detail_tab_change:   p => `/__feature__/tab-${p.to_tab     || 'unknown'}`,
  detail_chart_mode:   p => `/__feature__/chart-${p.mode     || 'unknown'}`,
  filter_applied:      _  => '/__feature__/filter',
  filter_cleared:      _  => '/__feature__/filter-cleared',
  graph_open:          _  => '/__feature__/graph',
  graph_mode_change:   p => `/__feature__/graph-${p.mode     || 'unknown'}`,
  graph_series_change: p => `/__feature__/series-${p.series  || 'unknown'}`,
};

// Fire page-load beacon.
_beacon(window.location.pathname);

export function trackPageView(path) {
  _beacon(path);
}

export function trackEvent(name, params = {}) {
  // Always beacon key feature interactions to the self-hosted tracker.
  const pathFn = _FEATURE_PATH[name];
  if (pathFn) _beacon(pathFn(params));

  // GA — only if the user has consented.
  if (typeof window.gtag !== 'function') return;
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value != null && value !== '')
  );
  window.gtag('event', name, cleanParams);
}
