/**
 * Phase 4 — Detail Panel Overlay
 *
 * Public API:
 *   initDetailPanel(getMapHash)              — wire DOM + set map-hash callback; call once on startup
 *   openDetail(locationId, entry, buSprite)  — fetch + render station detail, update URL hash
 *   closeDetail()                            — hide overlay, restore map URL hash
 */

import { renderQR } from './qr.js';
import { serialiseStationState, pushState } from './url-state.js';

/** Injected by initDetailPanel; returns the current map-state hash string (no leading #). */
let _getMapHash    = null;
/** Set by setReturnMode; returns the hash to restore when the panel closes. */
let _getReturnHash = null;
/** Which view to return to: 'map' | 'table'. */
let _returnMode    = 'map';

let _overlay    = null;
let _panel      = null;
/** Element focused before the panel opened — restored on close. */
let _lastFocused = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  // Keyboard handling: Escape to close; Tab to trap focus within the dialog.
  _overlay.addEventListener('keydown', (e) => {
    if (_overlay.hidden) return;

    if (e.key === 'Escape') {
      closeDetail();
      return;
    }

    if (e.key === 'Tab') {
      const focusable = [..._panel.querySelectorAll(FOCUSABLE)].filter(
        el => !el.closest('[hidden]') && el.offsetParent !== null
      );
      if (!focusable.length) { e.preventDefault(); return; }

      const first = focusable[0];
      const last  = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || !_panel.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !_panel.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  });
}

/**
 * Open the detail panel for a location.
 * Shows loading shimmer immediately, then fetches and renders data.
 * Falls back to index entry data (with BU tile if available) when no detail
 * JSON file exists.
 *
 * @param {string}      locationId
 * @param {object|null} indexEntry  — station record from index.json (may be null)
 * @param {object|null} buSprite    — { cell, cols, rows } sprite descriptor (may be null)
 */
export function openDetail(locationId, indexEntry = null, buSprite = null) {
  if (!_overlay || !_panel) return;

  // Save the element that triggered the open so we can restore focus on close.
  _lastFocused = document.activeElement;

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
      _panel.innerHTML = _renderDetail(locationId, data, indexEntry, buSprite);
      _attachClose();
      // Render station QR code.
      const qrContainer = _panel.querySelector('.detail-qr .qr-code');
      const stationUrl =
        `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
      renderQR(stationUrl, qrContainer, 120);
    })
    .catch(() => {
      // No detail JSON — show what we know from the index entry.
      _panel.innerHTML = _renderIndexDetail(locationId, indexEntry, buSprite);
      _attachClose();
      const qrContainer = _panel.querySelector('.detail-qr .qr-code');
      if (qrContainer) {
        const stationUrl =
          `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
        renderQR(stationUrl, qrContainer, 120);
      }
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

  // Restore focus to the element that was active before the panel opened.
  _lastFocused?.focus();
  _lastFocused = null;

  document.dispatchEvent(new CustomEvent('detail:closed', { detail: { returnTo } }));
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _attachClose() {
  const closeBtn = _panel.querySelector('.detail-close');
  closeBtn?.addEventListener('click', closeDetail);
  closeBtn?.focus();
}

/**
 * Build a CSS background-position string for a BU sprite tile.
 * Returns null if the entry or sprite descriptor is missing.
 */
const BU_ZOOM = 6;

function _buTileStyle(indexEntry, buSprite) {
  if (!buSprite || indexEntry?.bu_idx == null) return null;
  const { cell, cols } = buSprite;
  const col     = indexEntry.bu_idx % cols;
  const row     = Math.floor(indexEntry.bu_idx / cols);
  const display = cell * BU_ZOOM;
  const bx      = -(col * display);
  const by      = -(row * display);
  const sw      = cols * display;
  const sh      = buSprite.rows * display;
  return `width:${display}px;height:${display}px;`
    + `background-image:url('assets/bu-sprite.png');`
    + `background-size:${sw}px ${sh}px;`
    + `background-position:${bx}px ${by}px;`
    + `background-repeat:no-repeat;`;
}

function _renderBuSection(indexEntry, buSprite) {
  const style = _buTileStyle(indexEntry, buSprite);
  if (!style) return '';
  const pct5  = indexEntry.bu_5km  != null ? `${indexEntry.bu_5km.toFixed(1)}%` : '—';
  const pct20 = indexEntry.bu_20km != null ? `${indexEntry.bu_20km.toFixed(1)}%` : '—';
  return `
    <div class="detail-divider"></div>
    <div class="detail-bu">
      <div class="detail-bu-label">Built-up surface — 20 km context</div>
      <div class="detail-bu-map" style="${_esc(style)}" aria-label="Built-up surface map (20 km box)"></div>
      <div class="detail-bu-scores">
        <span class="bu-score"><span class="bu-score-label">5 km</span><span class="bu-score-value">${_esc(pct5)}</span></span>
        <span class="bu-score"><span class="bu-score-label">20 km</span><span class="bu-score-value">${_esc(pct20)}</span></span>
      </div>
    </div>`;
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

function _renderDetail(locationId, data, indexEntry, buSprite) {
  const vars = (data.variables ?? [])
    .map(v => `<span class="variable-tag">${_esc(v)}</span>`)
    .join('');

  // Merge index entry for elevation/coords if detail JSON lacks them
  const elevStr = data.elevation
    ?? (indexEntry?.elevation_m != null ? `${indexEntry.elevation_m} m` : '—');

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
        <span class="meta-value">${_esc(elevStr)}</span>
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
    ${_renderBuSection(indexEntry, buSprite)}
    <div class="detail-qr">
      <div class="qr-code"></div>
      <span class="qr-label">Share this station</span>
    </div>
  `;
}

/**
 * Render a panel from index-only data (no detail JSON available).
 * Shows all fields we have from the index: name, lat/lng, elevation, BU scores.
 */
function _renderIndexDetail(locationId, indexEntry, buSprite) {
  const name    = indexEntry?.name ?? locationId;
  const elevStr = indexEntry?.elevation_m != null ? `${indexEntry.elevation_m} m` : '—';
  const latStr  = indexEntry?.lat  != null ? indexEntry.lat.toFixed(4)  : '—';
  const lngStr  = indexEntry?.lng  != null ? indexEntry.lng.toFixed(4)  : '—';
  const catStr  = indexEntry?.category ?? '';

  return `
    <div class="detail-header">
      <div class="detail-header-text">
        <div class="detail-category">${_esc(catStr)}</div>
        <h2 class="detail-name">${_esc(name)}</h2>
      </div>
      <button class="detail-close" aria-label="Close panel" title="Close">×</button>
    </div>
    <div class="detail-meta">
      <div class="meta-item">
        <span class="meta-label">Station ID</span>
        <span class="meta-value">${_esc(locationId)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Elevation</span>
        <span class="meta-value">${_esc(elevStr)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Latitude</span>
        <span class="meta-value">${_esc(latStr)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Longitude</span>
        <span class="meta-value">${_esc(lngStr)}</span>
      </div>
    </div>
    ${_renderBuSection(indexEntry, buSprite)}
    <div class="detail-qr">
      <div class="qr-code"></div>
      <span class="qr-label">Share this station</span>
    </div>
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
