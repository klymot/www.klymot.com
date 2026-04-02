/**
 * Phase 4 — Detail Panel Overlay
 *
 * Public API:
 *   initDetailPanel(getMapHash)              — wire DOM + set map-hash callback; call once on startup
 *   openDetail(locationId, entry, buSprites) — fetch + render station detail, update URL hash
 *   closeDetail()                            — hide overlay, restore map URL hash
 *
 * buSprites: { bu2020: { cell, cols, rows } | null, bu1975: { cell, cols, rows } | null }
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

/** Current index entry and sprite descriptors, used by the change-canvas renderer. */
let _currentIndexEntry = null;
let _currentBuSprites  = null;

/** Cache of loaded sprite Image objects keyed by src URL. */
const _imgCache = {};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Display zoom: 32 px × 5 = 160 px. Odd total makes 1-px CSS crosshair centre at 80 px.
const BU_ZOOM = 5;

// ── Public API ────────────────────────────────────────────────────────────────

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
 * @param {object|null} buSprites   — { bu2020, bu1975 } sprite descriptors (may be null)
 */
export function openDetail(locationId, indexEntry = null, buSprites = null) {
  if (!_overlay || !_panel) return;

  _currentIndexEntry = indexEntry;
  _currentBuSprites  = buSprites;

  // Save the element that triggered the open so we can restore focus on close.
  _lastFocused = document.activeElement;

  // Push station state to URL immediately.
  pushState(serialiseStationState(locationId));

  // Hide the map QR while the detail panel is open.
  document.getElementById('map-qr-container')?.style.setProperty('display', 'none');

  // Show overlay with loading shimmer.
  _overlay.hidden = false;
  _panel.innerHTML = _renderShimmer();

  fetch(`data/locations/${encodeURIComponent(locationId)}.json`)
    .then(r => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    })
    .then(data => {
      _panel.innerHTML = _renderDetail(locationId, data, indexEntry, buSprites);
      _attachHandlers();
      // Render station QR code.
      const qrContainer = _panel.querySelector('.detail-qr .qr-code');
      const stationUrl =
        `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
      renderQR(stationUrl, qrContainer, 120);
    })
    .catch(() => {
      // No detail JSON — show what we know from the index entry.
      _panel.innerHTML = _renderIndexDetail(locationId, indexEntry, buSprites);
      _attachHandlers();
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

  // Restore map QR only when returning to the map view.
  if (returnTo === 'map') {
    document.getElementById('map-qr-container')?.style.removeProperty('display');
  }

  // Restore focus to the element that was active before the panel opened.
  _lastFocused?.focus();
  _lastFocused = null;

  document.dispatchEvent(new CustomEvent('detail:closed', { detail: { returnTo } }));
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _attachHandlers() {
  const closeBtn = _panel.querySelector('.detail-close');
  closeBtn?.addEventListener('click', closeDetail);
  closeBtn?.focus();

  // Section-level tab switching
  _panel.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchSectionTab(tab.dataset.section));
  });

  // BU tab switching
  _panel.querySelectorAll('.bu-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchBuTab(tab.dataset.tab));
  });
}

function _switchSectionTab(sectionName) {
  _panel.querySelectorAll('.section-tab').forEach(t => {
    const active = t.dataset.section === sectionName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  _panel.querySelectorAll('.section-panel').forEach(p => {
    p.hidden = p.dataset.section !== sectionName;
  });
}

function _switchBuTab(tabName) {
  _panel.querySelectorAll('.bu-tab').forEach(t => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  _panel.querySelectorAll('.bu-tab-panel').forEach(panel => {
    panel.hidden = panel.dataset.panel !== tabName;
    if (panel.dataset.panel === tabName && tabName === 'change') {
      const canvas = panel.querySelector('canvas');
      if (canvas && !canvas._rendered) {
        canvas._rendered = true;
        _renderChangeCanvas(canvas);
      }
    }
  });
}

// ── BU sprite tile helpers ────────────────────────────────────────────────────

/**
 * Build inline CSS for a sprite tile.
 * @param {object} indexEntry   — location record from index.json
 * @param {object} spriteDesc   — { cell, cols, rows }
 * @param {string} idxKey       — e.g. 'bu_2020_idx'
 * @param {string} spriteFile   — e.g. 'bu_2020_sprite.png'
 */
function _buTileStyle(indexEntry, spriteDesc, idxKey, spriteFile) {
  if (!spriteDesc || indexEntry?.[idxKey] == null) return null;
  const { cell, cols } = spriteDesc;
  const col     = indexEntry[idxKey] % cols;
  const row     = Math.floor(indexEntry[idxKey] / cols);
  const display = cell * BU_ZOOM;
  const bx      = -(col * display);
  const by      = -(row * display);
  const sw      = cols * display;
  const sh      = spriteDesc.rows * display;
  return `width:${display}px;height:${display}px;`
    + `background-image:url('assets/${spriteFile}');`
    + `background-size:${sw}px ${sh}px;`
    + `background-position:${bx}px ${by}px;`
    + `background-repeat:no-repeat;`;
}

/** Wrap a .detail-bu-map div with crosshair and 5 km scale bar overlays. */
function _buMapWrap(mapDiv, ariaLabel) {
  return `<div class="detail-bu-wrap">
    ${mapDiv}
    <div class="detail-bu-crosshair" aria-hidden="true"></div>
    <div class="detail-bu-scale" aria-hidden="true">
      <div class="scale-bar"></div>
      <div class="scale-label">5 km</div>
    </div>
  </div>`;
}

function _renderBuSection(indexEntry, buSprites) {
  const bu2020 = buSprites?.bu2020;
  const bu1975 = buSprites?.bu1975;

  const style2020 = _buTileStyle(indexEntry, bu2020, 'bu_2020_idx', 'bu_2020_sprite.png');
  const style1975 = _buTileStyle(indexEntry, bu1975, 'bu_1975_idx', 'bu_1975_sprite.png');

  if (!style2020 && !style1975) return '';

  const display = (bu2020?.cell ?? bu1975?.cell ?? 32) * BU_ZOOM;

  const has1975   = !!style1975;
  // Show Change tab whenever both sprites are present — canvas diff is client-side
  const hasChange = has1975 && !!style2020;

  // ── Per-year score helpers ────────────────────────────────────────────────
  function scorePct(val) { return val != null ? `${val.toFixed(1)}%` : '—'; }

  function scoreRow(prefix) {
    const s1km  = scorePct(indexEntry?.[`bu_${prefix}_1km`]);
    const s5km  = scorePct(indexEntry?.[`bu_${prefix}_5km`]);
    const s20km = scorePct(indexEntry?.[`bu_${prefix}_20km`]);
    return `
      <div class="detail-bu-scores">
        <span class="bu-score"><span class="bu-score-label">1 km</span><span class="bu-score-value">${_esc(s1km)}</span></span>
        <span class="bu-score"><span class="bu-score-label">5 km</span><span class="bu-score-value">${_esc(s5km)}</span></span>
        <span class="bu-score"><span class="bu-score-label">20 km</span><span class="bu-score-value">${_esc(s20km)}</span></span>
      </div>`;
  }

  function changeScoreRow() {
    const raw = indexEntry?.bu_change;
    const txt = raw != null ? `${raw >= 0 ? '+' : ''}${raw.toFixed(1)}%` : '—';
    const cls = raw != null ? (raw > 0 ? ' bu-score-up' : raw < 0 ? ' bu-score-down' : '') : '';
    return `
      <div class="detail-bu-scores">
        <span class="bu-score"><span class="bu-score-label">Δ 5 km</span><span class="bu-score-value${cls}">${_esc(txt)}</span></span>
      </div>`;
  }

  const tabs = `
    <div class="bu-tabs" role="tablist" aria-label="BU year">
      <button class="bu-tab active" role="tab" data-tab="2020" aria-selected="true">2020</button>
      ${has1975 ? `<button class="bu-tab" role="tab" data-tab="1975" aria-selected="false">1975</button>` : ''}
      ${hasChange ? `<button class="bu-tab" role="tab" data-tab="change" aria-selected="false">Change</button>` : ''}
    </div>`;

  const panel2020 = style2020 ? `
    <div class="bu-tab-panel" data-panel="2020">
      ${_buMapWrap(`<div class="detail-bu-map" style="${_esc(style2020)}" aria-label="Built-up surface 2020 (20 km box)"></div>`)}
      ${scoreRow('2020')}
    </div>` : '';

  const panel1975 = has1975 ? `
    <div class="bu-tab-panel" data-panel="1975" hidden>
      ${_buMapWrap(`<div class="detail-bu-map" style="${_esc(style1975)}" aria-label="Built-up surface 1975 (20 km box)"></div>`)}
      ${scoreRow('1975')}
    </div>` : '';

  const panelChange = hasChange ? `
    <div class="bu-tab-panel" data-panel="change" hidden>
      ${_buMapWrap(`<canvas class="detail-bu-change-canvas" width="${display}" height="${display}" aria-label="Built-up surface change 1975–2020"></canvas>`)}
      ${changeScoreRow()}
    </div>` : '';

  return `
    <div class="detail-sections">
      <div class="section-tabs" role="tablist" aria-label="Detail sections">
        <button class="section-tab active" role="tab" data-section="bu-surface" aria-selected="true">Built-Up Surface</button>
      </div>
      <div class="section-panel" data-section="bu-surface">
        <div class="detail-bu">
          ${tabs}
          <div class="bu-tab-panels">
            ${panel2020}${panel1975}${panelChange}
          </div>
        </div>
      </div>
    </div>`;
}

// ── Change canvas ─────────────────────────────────────────────────────────────

function _loadImg(src) {
  if (!_imgCache[src]) {
    _imgCache[src] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  return _imgCache[src];
}

async function _renderChangeCanvas(canvas) {
  if (!canvas || !_currentIndexEntry || !_currentBuSprites) return;
  const { bu2020, bu1975 } = _currentBuSprites;
  if (!bu2020 || !bu1975) return;

  const idx2020 = _currentIndexEntry.bu_2020_idx;
  const idx1975 = _currentIndexEntry.bu_1975_idx;
  if (idx2020 == null || idx1975 == null) return;

  const cell    = bu2020.cell;
  const display = cell * BU_ZOOM;

  try {
    const [img2020, img1975] = await Promise.all([
      _loadImg('assets/bu_2020_sprite.png'),
      _loadImg('assets/bu_1975_sprite.png'),
    ]);

    // Draw each sprite tile to an offscreen canvas
    const draw = (img, spriteDesc, idx) => {
      const c = document.createElement('canvas');
      c.width = c.height = display;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const col = idx % spriteDesc.cols;
      const row = Math.floor(idx / spriteDesc.cols);
      ctx.drawImage(img, col * cell, row * cell, cell, cell, 0, 0, display, display);
      return ctx.getImageData(0, 0, display, display).data;
    };

    const d2020 = draw(img2020, bu2020, idx2020);
    const d1975 = draw(img1975, bu1975, idx1975);

    canvas.width  = display;
    canvas.height = display;
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(display, display);
    const out     = imgData.data;

    for (let i = 0; i < d2020.length; i += 4) {
      // Use (R − B) as a monotone built-up proxy.
      // Palette: 0% → (8,48,107) R-B = -99; 50%+ → (157,2,8) R-B = +149.
      const v2 = d2020[i] - d2020[i + 2];
      const v7 = d1975[i] - d1975[i + 2];
      const diff = v2 - v7;

      // Dead zone ±4 to avoid noise
      if (diff > 4) {
        const mag = Math.min(255, diff * 2);
        out[i] = mag; out[i + 1] = 0; out[i + 2] = 0;
      } else if (diff < -4) {
        const mag = Math.min(255, -diff * 2);
        out[i] = 0; out[i + 1] = 0; out[i + 2] = mag;
      } else {
        out[i] = 18; out[i + 1] = 18; out[i + 2] = 18;
      }
      out[i + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
  } catch (err) {
    // If images fail to load (e.g. 1975 sprite not yet generated), show a message
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, display, display);
    ctx.fillStyle = '#5a6880';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('1975 sprite not yet', display / 2, display / 2 - 8);
    ctx.fillText('generated — run:', display / 2, display / 2 + 8);
    ctx.fillText('generate_bu_tiles.py --year 1975', display / 2, display / 2 + 24);
  }
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

function _renderDetail(locationId, data, indexEntry, buSprites) {
  const vars = (data.variables ?? [])
    .map(v => `<span class="variable-tag">${_esc(v)}</span>`)
    .join('');

  // Merge index entry for elevation/coords if detail JSON lacks them
  const elevStr = data.elevation
    ?? (indexEntry?.elevation_m != null ? `${indexEntry.elevation_m} m` : '—');

  return `
    <div class="detail-top">
      <div class="detail-top-main">
        <div class="detail-header-text">
          <div class="detail-category">${_esc(data.type ?? '')}</div>
          <h2 class="detail-name">${_esc(data.name ?? locationId)}</h2>
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
      </div>
      <div class="detail-top-aside">
        <div class="detail-qr">
          <div class="qr-code"></div>
          <span class="qr-label">Share this station</span>
        </div>
      </div>
      <button class="detail-close" aria-label="Close panel" title="Close">×</button>
    </div>
    <div class="detail-divider"></div>
    <div class="detail-description">${_esc(data.description ?? '')}</div>
    ${vars ? `<div class="detail-variables">${vars}</div>` : ''}
    ${_renderBuSection(indexEntry, buSprites)}
  `;
}

/**
 * Render a panel from index-only data (no detail JSON available).
 */
function _renderIndexDetail(locationId, indexEntry, buSprites) {
  const name    = indexEntry?.name ?? locationId;
  const elevStr = indexEntry?.elevation_m != null ? `${indexEntry.elevation_m} m` : '—';
  const latStr  = indexEntry?.lat  != null ? indexEntry.lat.toFixed(4)  : '—';
  const lngStr  = indexEntry?.lng  != null ? indexEntry.lng.toFixed(4)  : '—';
  const catStr  = indexEntry?.category ?? '';

  return `
    <div class="detail-top">
      <div class="detail-top-main">
        <div class="detail-header-text">
          <div class="detail-category">${_esc(catStr)}</div>
          <h2 class="detail-name">${_esc(name)}</h2>
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
      </div>
      <div class="detail-top-aside">
        <div class="detail-qr">
          <div class="qr-code"></div>
          <span class="qr-label">Share this station</span>
        </div>
      </div>
      <button class="detail-close" aria-label="Close panel" title="Close">×</button>
    </div>
    ${_renderBuSection(indexEntry, buSprites)}
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
