/**
 * Phase 4 — Detail Panel Overlay
 *
 * Public API:
 *   initDetailPanel(getMapHash)  — wire DOM + set map-hash callback; call once on startup
 *   openDetail(locationId)       — fetch + render station detail, update URL hash
 *   closeDetail()                — hide overlay, restore map URL hash
 */

import { renderQR } from './qr.js';
import { serialiseStationState, pushState } from './url-state.js';

/** Injected by initDetailPanel; returns the current map-state hash string (no leading #). */
let _getMapHash    = null;
/** Set by setReturnMode; returns the hash to restore when the panel closes. */
let _getReturnHash = null;
/** Which view to return to: 'map' | 'table'. */
let _returnMode    = 'map';

let _overlay = null;
let _panel   = null;

/**
 * Initialise the detail panel.
 * @param {function(): string} getMapHash  — returns serialiseMapState(…) for the active map
 */
/**
 * Tell the panel which view to return to when it closes.
 * @param {'map'|'table'} mode
 * @param {function(): string} getHashFn  — returns the hash to restore on close
 */
export function setReturnMode(mode, getHashFn) {
  _returnMode    = mode;
  _getReturnHash = getHashFn ?? _getMapHash;
}

export function initDetailPanel(getMapHash) {
  _getMapHash    = getMapHash;
  _getReturnHash = getMapHash;
  _returnMode    = 'map';
  _overlay       = document.getElementById('detail-overlay');
  _panel      = document.getElementById('detail-panel');

  if (!_overlay) return;

  // Backdrop click closes the panel.
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeDetail();
  });

  // Escape key closes the panel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _overlay && !_overlay.hidden) {
      closeDetail();
    }
  });
}

/**
 * Open the detail panel for a location.
 * Shows loading shimmer immediately, then fetches and renders data.
 * @param {string} locationId
 */
export function openDetail(locationId) {
  if (!_overlay || !_panel) return;

  // Push station state to URL immediately.
  pushState(serialiseStationState(locationId));

  // Show overlay with loading shimmer.
  _overlay.hidden = false;
  _panel.innerHTML = _renderShimmer();

  fetch(`data/locations/${encodeURIComponent(locationId)}.json`)
    .then(r => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    })
    .then(data => {
      _panel.innerHTML = _renderDetail(locationId, data);
      _panel.querySelector('.detail-close')
        ?.addEventListener('click', closeDetail);

      // Render station QR code.
      const qrContainer = _panel.querySelector('.detail-qr .qr-code');
      const stationUrl =
        `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
      renderQR(stationUrl, qrContainer, 120);
    })
    .catch(() => {
      _panel.innerHTML = _renderNoData();
      _panel.querySelector('.detail-close')
        ?.addEventListener('click', closeDetail);
    });
}

/**
 * Close the detail panel, restore the appropriate view URL hash, and notify
 * app.js which view to return to via the 'detail:closed' event.
 */
export function closeDetail() {
  if (!_overlay) return;
  _overlay.hidden = true;
  _panel.innerHTML = '';

  if (_getReturnHash) pushState(_getReturnHash());

  const returnTo = _returnMode;
  // Reset to map defaults so the next open starts clean.
  _returnMode    = 'map';
  _getReturnHash = _getMapHash;

  document.dispatchEvent(new CustomEvent('detail:closed', { detail: { returnTo } }));
}

// ── Private renderers ─────────────────────────────────────────────────────────

function _renderShimmer() {
  return `
    <div class="detail-loading" aria-label="Loading station data" role="status">
      <div class="loading-bar short"></div>
      <div class="loading-bar long" style="height:1.75rem;margin-bottom:1.25rem"></div>
      <div class="loading-bar medium"></div>
      <div class="loading-bar medium"></div>
      <div class="loading-bar short"></div>
      <div class="loading-bar long" style="margin-top:1rem"></div>
      <div class="loading-bar long"></div>
      <div class="loading-bar medium"></div>
    </div>
  `;
}

function _renderDetail(locationId, data) {
  const vars = (data.variables ?? [])
    .map(v => `<span class="variable-tag">${_esc(v)}</span>`)
    .join('');

  return `
    <div class="detail-header">
      <div class="detail-header-text">
        <div class="detail-category">${_esc(data.type ?? '')}</div>
        <h2 class="detail-name">${_esc(data.name ?? locationId)}</h2>
      </div>
      <button class="detail-close" aria-label="Close panel" title="Close">×</button>
    </div>
    <div class="detail-meta">
      <div class="meta-item">
        <span class="meta-label">Country</span>
        <span class="meta-value">${_esc(data.country ?? '—')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Elevation</span>
        <span class="meta-value">${_esc(data.elevation ?? '—')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Established</span>
        <span class="meta-value">${_esc(data.established ?? '—')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Network</span>
        <span class="meta-value">${_esc(data.network ?? '—')}</span>
      </div>
    </div>
    <div class="detail-divider"></div>
    <div class="detail-description">${_esc(data.description ?? '')}</div>
    ${vars ? `<div class="detail-variables">${vars}</div>` : ''}
    <div class="detail-qr">
      <div class="qr-code"></div>
      <span class="qr-label">Share this station</span>
    </div>
  `;
}

function _renderNoData() {
  return `
    <div class="detail-header">
      <div class="detail-header-text">
        <div class="detail-name">No data available</div>
      </div>
      <button class="detail-close" aria-label="Close panel" title="Close">×</button>
    </div>
    <div class="detail-description">No detailed information is available for this location.</div>
  `;
}

/** HTML-escape a value to prevent XSS when setting innerHTML. */
function _esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
