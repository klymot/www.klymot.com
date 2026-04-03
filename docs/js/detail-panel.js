/**
 * Phase 4 — Detail Panel Overlay
 *
 * Public API:
 *   initDetailPanel(getMapHash)              — wire DOM + set map-hash callback; call once on startup
 *   openDetail(locationId, entry, sprites)   — fetch + render station detail, update URL hash
 *   closeDetail()                            — hide overlay, restore map URL hash
 *
 * sprites: { bu2020, bu1975, pop2020, pop1975 } — any may be null if not yet generated
 */

import { renderQR } from './qr.js';
import { serialiseStationState, pushState } from './url-state.js';
import { trackEvent } from './analytics.js';
import { TempChart } from './temp-chart.js';

/**
 * State to restore when the next detail panel opens (set by setRestoreState).
 * Contains the parsed URL station state: section, mode, zoomMin, zoomMax, inspector.
 */
let _restoreState = null;

/**
 * Called by app.js before openDetail() when navigating to a station URL that
 * contains detail panel state (tab, mode, zoom, inspector).
 * @param {object|null} state
 */
export function setRestoreState(state) {
  _restoreState = state;
}

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
let _currentLocationId = null;

/** Active TempChart instances keyed by section name. Destroyed on panel close. */
let _charts = {};

/** Shared chart mode across both temp sections (kept in sync). */
let _sharedChartMode = 'monthly';

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

  _currentLocationId = locationId;
  _currentIndexEntry = indexEntry;
  _currentBuSprites  = buSprites;

  // Save the element that triggered the open so we can restore focus on close.
  _lastFocused = document.activeElement;

  // Push station state to URL immediately.
  pushState(serialiseStationState(locationId));
  trackEvent('detail_open', { station_id: locationId });

  // Destroy any charts from a previous panel before replacing innerHTML.
  _destroyCharts();

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
  _destroyCharts();
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
  _currentLocationId = null;

  document.dispatchEvent(new CustomEvent('detail:closed', { detail: { returnTo } }));
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _destroyCharts() {
  for (const chart of Object.values(_charts)) chart?.destroy();
  _charts = {};
}

function _initCharts() {
  const locationId = _currentLocationId;
  if (!locationId) return;

  const SECTIONS = ['temp-qcu', 'temp-qcf'];
  const PATHS    = ['qcu', 'qcf'];

  // Snapshot and consume the restore state so subsequent openDetail() calls
  // (e.g. from map-marker clicks) don't accidentally inherit it.
  const restore = _restoreState;
  _restoreState = null;

  // Determine shared mode from restore state or current shared mode.
  const restoreSection = restore?.section;
  if (restore?.mode &&
      (restoreSection === 'temp-qcu' || restoreSection === 'temp-qcf')) {
    _sharedChartMode = restore.mode;
  }

  // Track data-load completion so we can compute the cross-chart union range.
  let loadsRemaining = SECTIONS.length;
  function _onChartDataLoaded() {
    loadsRemaining--;
    if (loadsRemaining > 0) return;

    // Both charts have loaded — compute the union of their data extents.
    let globalMin = Infinity, globalMax = -Infinity;
    for (const s of SECTIONS) {
      const range = _charts[s]?.getDataRange();
      if (!range) continue;
      if (range.min < globalMin) globalMin = range.min;
      if (range.max > globalMax) globalMax = range.max;
    }

    if (!isFinite(globalMin)) return;

    // Apply the union range to all charts (resets zoom to the global domain).
    // Then layer any URL-restored zoom/inspector on top.
    for (const s of SECTIONS) {
      const c = _charts[s];
      if (!c) continue;
      c.setGlobalRange(globalMin, globalMax);
      if (restore?.zoomMin != null && restore.zoomMax != null) {
        c.setZoom(restore.zoomMin, restore.zoomMax);
      }
    }

    // Apply inspector only to the section that was active when the URL was shared.
    const activeChart = _charts[restore?.section];
    if (activeChart && restore?.inspector) {
      const insp = restore.inspector;
      if (insp.type === 'line')  activeChart.setInspector(insp.x);
      if (insp.type === 'heat')  activeChart.setInspectorCell(insp.year, insp.month);
    }

    // Re-serialise URL and refresh QR now that the final zoom/inspector are set.
    _updateStationUrl();
  }

  SECTIONS.forEach((section, i) => {
    const wrap = _panel.querySelector(`[data-section="${section}"] .chart-canvas-wrap`);
    if (!wrap) return;

    const chart = new TempChart(wrap);
    _charts[section] = chart;

    // Apply the shared mode immediately (before data loads, for button state).
    if (_sharedChartMode !== 'monthly') {
      chart.setMode(_sharedChartMode);
      _panel.querySelectorAll(`[data-section="${section}"] .chart-mode-btn`).forEach(b => {
        const active = b.dataset.mode === _sharedChartMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    }

    fetch(`data/${PATHS[i]}/${encodeURIComponent(locationId)}.csv`)
      .then(r => r.ok ? r.text() : '')
      .catch(() => '')
      .then(text => {
        chart.load(text);
        _onChartDataLoaded();
      });

    // Mode toggle buttons — sync across both temp sections.
    _panel.querySelectorAll(`[data-section="${section}"] .chart-mode-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        _sharedChartMode = mode;
        SECTIONS.forEach(s => {
          _panel.querySelectorAll(`[data-section="${s}"] .chart-mode-btn`).forEach(b => {
            const active = b.dataset.mode === mode;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', String(active));
          });
          _charts[s]?.setMode(mode);
        });
        _updateStationUrl();
      });
    });

    // Zoom buttons — chart:zoom event (fired by zoomIn/zoomOut/resetZoom) handles
    // syncing to the other section and updating the URL, so no extra call needed here.
    _panel.querySelectorAll(`[data-section="${section}"] .chart-zoom-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'zoom-in')         chart.zoomIn();
        else if (action === 'zoom-out')   chart.zoomOut();
        else if (action === 'zoom-reset') chart.resetZoom();
      });
    });

    // When zoom changes (drag-pan or buttons), mirror it to the other temp section.
    wrap.addEventListener('chart:zoom', () => {
      const zoom = chart.getZoom();
      const otherSection = section === 'temp-qcu' ? 'temp-qcf' : 'temp-qcu';
      _charts[otherSection]?.setZoom(zoom.min, zoom.max);
      _updateStationUrl();
    });
    wrap.addEventListener('chart:inspect', () => _updateStationUrl());
  });
}

function _attachHandlers() {
  const closeBtn = _panel.querySelector('.detail-close');
  closeBtn?.addEventListener('click', closeDetail);
  closeBtn?.focus();

  // Section-level tab switching.
  _panel.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchSectionTab(tab.dataset.section));
  });

  // Year tab switching — BU and Population tabs are synced together.
  _panel.querySelectorAll('.bu-tab, .pop-tab').forEach(tab => {
    tab.addEventListener('click', () => _switchYearTab(tab.dataset.tab));
  });

  // Apply restore state for section tab.
  if (_restoreState?.section) {
    _switchSectionTab(_restoreState.section);
  }
  // Apply restore state for year tab (bu/pop sections).
  if (_restoreState?.mode &&
      (_restoreState.section === 'bu-surface' || _restoreState.section === 'population')) {
    _switchYearTab(_restoreState.mode);
  }

  // Initialize temperature charts (must be after DOM is ready).
  _initCharts();
}

function _switchSectionTab(sectionName) {
  const currentSection = _panel.querySelector('.section-tab.active')?.dataset.section;
  if (currentSection === sectionName) return;

  _panel.querySelectorAll('.section-tab').forEach(t => {
    const active = t.dataset.section === sectionName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  _panel.querySelectorAll('.section-panel').forEach(p => {
    p.hidden = p.dataset.section !== sectionName;
  });

  // Trigger chart resize — the panel had display:none so clientWidth was 0.
  _charts[sectionName]?.resize();

  trackEvent('detail_tab_change', {
    station_id: _currentLocationId,
    from_tab: currentSection,
    to_tab: sectionName,
  });

  _updateStationUrl();
}

/**
 * Switch the year tab for both BU Surface and Population sections simultaneously
 * (they share the same subtabs: 2020 / 1975 / Change).
 * Only updates a section if it has a tab matching tabName.
 */
function _switchYearTab(tabName) {
  // Helper: switch tabs+panels for a given tab selector / panel selector / change-renderer.
  function _applyYearTab(tabSel, panelSel, renderChangeFn) {
    const tabs   = [..._panel.querySelectorAll(tabSel)];
    const target = tabs.find(t => t.dataset.tab === tabName);
    if (!target) return; // this section doesn't have this tab — skip
    tabs.forEach(t => {
      const active = t === target;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    });
    _panel.querySelectorAll(panelSel).forEach(panel => {
      panel.hidden = panel.dataset.panel !== tabName;
      if (panel.dataset.panel === tabName && tabName === 'change') {
        const canvas = panel.querySelector('canvas');
        if (canvas && !canvas._rendered) {
          canvas._rendered = true;
          renderChangeFn(canvas);
        }
      }
    });
  }

  _applyYearTab('.bu-tab',  '.bu-tab-panel',  _renderChangeCanvas);
  _applyYearTab('.pop-tab', '.pop-tab-panel', _renderPopChangeCanvas);

  _updateStationUrl();
}

/** Serialise current panel state, update the URL hash, and refresh the detail QR code. */
function _updateStationUrl() {
  if (!_currentLocationId) return;

  const activeTab = _panel.querySelector('.section-tab.active');
  const section   = activeTab?.dataset.section;
  const detail    = { section };

  if (section === 'temp-qcu' || section === 'temp-qcf') {
    const chart = _charts[section];
    detail.mode = _sharedChartMode;
    if (chart) {
      const zoom = chart.getZoom();
      detail.zoomMin = zoom?.min;
      detail.zoomMax = zoom?.max;
      detail.inspector = chart.getInspector();
    }
  } else if (section === 'bu-surface' || section === 'population') {
    const yearTab = _panel.querySelector('.bu-tab.active') ??
                    _panel.querySelector('.pop-tab.active');
    detail.mode = yearTab?.dataset.tab;
  }

  pushState(serialiseStationState(_currentLocationId, detail));

  // Keep the detail panel QR code in sync with the current shareable URL.
  const qrContainer = _panel?.querySelector('.detail-qr .qr-code');
  if (qrContainer) {
    renderQR(window.location.href, qrContainer, 120);
  }
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

/**
 * Build the combined detail-sections block (temperature charts + Built-Up Surface + Population).
 * Temperature sections are always rendered. BU/Pop are omitted when no sprites are available.
 */
function _renderDataSections(indexEntry, sprites) {
  const buContent  = _buSectionContent(indexEntry, sprites);
  const popContent = _popSectionContent(indexEntry, sprites);

  const tabs   = [];
  const panels = [];

  // Temperature charts — always shown (chart handles no-data state internally)
  tabs.push(`<button class="section-tab active" role="tab" data-section="temp-qcu" aria-selected="true">Unadjusted</button>`);
  tabs.push(`<button class="section-tab" role="tab" data-section="temp-qcf" aria-selected="false">Adjusted</button>`);
  panels.push(`<div class="section-panel" data-section="temp-qcu">${_tempChartPanel()}</div>`);
  panels.push(`<div class="section-panel" data-section="temp-qcf" hidden>${_tempChartPanel()}</div>`);

  if (buContent) {
    tabs.push(`<button class="section-tab" role="tab" data-section="bu-surface" aria-selected="false">Built-Up Surface</button>`);
    panels.push(`<div class="section-panel" data-section="bu-surface" hidden>${buContent}</div>`);
  }
  if (popContent) {
    tabs.push(`<button class="section-tab" role="tab" data-section="population" aria-selected="false">Population</button>`);
    panels.push(`<div class="section-panel" data-section="population" hidden>${popContent}</div>`);
  }

  return `
    <div class="detail-sections">
      <div class="section-tabs" role="tablist" aria-label="Detail sections">
        ${tabs.join('')}
      </div>
      ${panels.join('')}
    </div>`;
}

/** HTML scaffold for a temperature chart panel (chart is initialised in _initCharts). */
function _tempChartPanel() {
  return `
    <div class="temp-chart-section">
      <div class="chart-controls">
        <div class="chart-mode-toggle" role="group" aria-label="Time resolution">
          <button class="chart-mode-btn active" data-mode="monthly" aria-pressed="true">Monthly</button>
          <button class="chart-mode-btn" data-mode="yearly" aria-pressed="false">Annual</button>
          <button class="chart-mode-btn" data-mode="heatmap" aria-pressed="false">Heatmap</button>
        </div>
        <div class="chart-zoom-controls" role="group" aria-label="Zoom controls">
          <button class="chart-zoom-btn" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="chart-zoom-btn" data-action="zoom-reset" title="Reset zoom" aria-label="Reset zoom">⊙</button>
          <button class="chart-zoom-btn" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="chart-canvas-wrap"></div>
      <div class="chart-heat-legend" hidden aria-label="Temperature colour scale">
        <span class="heat-cold-label heat-label">—</span>
        <div class="heat-legend-bar" aria-hidden="true"></div>
        <span class="heat-hot-label heat-label">—</span>
      </div>
      <p class="chart-hint">Drag to pan · Hover for temperature</p>
    </div>`;
}

function _buSectionContent(indexEntry, sprites) {
  const bu2020 = sprites?.bu2020;
  const bu1975 = sprites?.bu1975;

  const style2020 = _buTileStyle(indexEntry, bu2020, 'bu_2020_idx', 'bu_2020_sprite.png');
  const style1975 = _buTileStyle(indexEntry, bu1975, 'bu_1975_idx', 'bu_1975_sprite.png');

  if (!style2020 && !style1975) return '';

  const display = (bu2020?.cell ?? bu1975?.cell ?? 32) * BU_ZOOM;
  const has1975   = !!style1975;
  const hasChange = has1975 && !!style2020;

  function scorePct(val) { return val != null ? `${val.toFixed(1)}%` : '—'; }

  // Gradient legend matching generate_bu_tiles.py PALETTE, stops on log scale
  const buLegend = `
    <div class="pop-legend">
      <div class="bu-legend-bar" aria-hidden="true"></div>
      <div class="pop-legend-labels" aria-hidden="true">
        <span>0</span><span>1%</span><span>6%</span><span>50%+</span>
      </div>
      <div class="pop-legend-caption">% built-up</div>
    </div>`;

  function scoreRow(prefix) {
    const s1km  = scorePct(indexEntry?.[`bu_${prefix}_1km`]);
    const s5km  = scorePct(indexEntry?.[`bu_${prefix}_5km`]);
    const s20km = scorePct(indexEntry?.[`bu_${prefix}_20km`]);
    return `
      <div class="pop-score-col">
        ${buLegend}
        <div class="detail-bu-scores">
          <span class="bu-score"><span class="bu-score-label">1 km</span><span class="bu-score-value">${_esc(s1km)}</span></span>
          <span class="bu-score"><span class="bu-score-label">5 km</span><span class="bu-score-value">${_esc(s5km)}</span></span>
          <span class="bu-score"><span class="bu-score-label">20 km</span><span class="bu-score-value">${_esc(s20km)}</span></span>
        </div>
      </div>`;
  }

  const changeLegend = `
    <div class="pop-legend">
      <div class="change-legend-bar" aria-hidden="true"></div>
      <div class="pop-legend-labels" aria-hidden="true">
        <span class="change-label-low">−</span><span>0</span><span class="change-label-high">+</span>
      </div>
      <div class="pop-legend-caption">change in % built-up</div>
    </div>`;

  function changeScoreRow() {
    function delta(suffix) {
      const v2020 = indexEntry?.[`bu_2020_${suffix}`];
      const v1975 = indexEntry?.[`bu_1975_${suffix}`];
      if (v2020 == null || v1975 == null) return null;
      return v2020 - v1975;
    }
    function fmt(d) {
      if (d == null) return '—';
      return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    }
    function cls(d) {
      return d == null ? '' : d > 0 ? ' bu-score-up' : d < 0 ? ' bu-score-down' : '';
    }
    const d1km = delta('1km'), d5km = delta('5km'), d20km = delta('20km');
    return `
      <div class="pop-score-col">
        ${changeLegend}
        <div class="detail-bu-scores">
          <span class="bu-score"><span class="bu-score-label">Δ 1 km</span><span class="bu-score-value${cls(d1km)}">${_esc(fmt(d1km))}</span></span>
          <span class="bu-score"><span class="bu-score-label">Δ 5 km</span><span class="bu-score-value${cls(d5km)}">${_esc(fmt(d5km))}</span></span>
          <span class="bu-score"><span class="bu-score-label">Δ 20 km</span><span class="bu-score-value${cls(d20km)}">${_esc(fmt(d20km))}</span></span>
        </div>
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
      ${_buMapWrap(`<canvas class="detail-bu-change-canvas" width="${display}" height="${display}" style="width:${display}px;height:${display}px" aria-label="Built-up surface change 1975–2020"></canvas>`)}
      ${changeScoreRow()}
    </div>` : '';

  return `
    <div class="detail-bu">
      ${tabs}
      <div class="bu-tab-panels">
        ${panel2020}${panel1975}${panelChange}
      </div>
    </div>`;
}

function _popSectionContent(indexEntry, sprites) {
  const pop2020 = sprites?.pop2020;
  const pop1975 = sprites?.pop1975;

  const style2020 = _buTileStyle(indexEntry, pop2020, 'pop_2020_idx', 'pop_2020_sprite.png');
  const style1975 = _buTileStyle(indexEntry, pop1975, 'pop_1975_idx', 'pop_1975_sprite.png');

  if (!style2020 && !style1975) return '';

  const has1975   = !!style1975;
  const hasChange = has1975 && !!style2020;

  // Format population density as "1,234 /km²"
  function fmtDensity(val) {
    if (val == null) return '—';
    return val.toLocaleString() + '\u202f/km²';
  }

  // Gradient legend: colours match generate_pop_tiles.py PALETTE, stops on log scale
  const legend = `
    <div class="pop-legend">
      <div class="pop-legend-bar" aria-hidden="true"></div>
      <div class="pop-legend-labels" aria-hidden="true">
        <span>0</span><span>10</span><span>100</span><span>1k</span><span>10k+</span>
      </div>
      <div class="pop-legend-caption">people / km²</div>
    </div>`;

  function scoreRow(prefix) {
    const s1km  = fmtDensity(indexEntry?.[`pop_${prefix}_1km`]);
    const s5km  = fmtDensity(indexEntry?.[`pop_${prefix}_5km`]);
    const s20km = fmtDensity(indexEntry?.[`pop_${prefix}_20km`]);
    return `
      <div class="detail-bu-scores">
        <span class="bu-score"><span class="bu-score-label">1 km</span><span class="bu-score-value">${_esc(s1km)}</span></span>
        <span class="bu-score"><span class="bu-score-label">5 km</span><span class="bu-score-value">${_esc(s5km)}</span></span>
        <span class="bu-score"><span class="bu-score-label">20 km</span><span class="bu-score-value">${_esc(s20km)}</span></span>
      </div>`;
  }

  const popChangeLegend = `
    <div class="pop-legend">
      <div class="change-legend-bar" aria-hidden="true"></div>
      <div class="pop-legend-labels" aria-hidden="true">
        <span class="change-label-low">−</span><span>0</span><span class="change-label-high">+</span>
      </div>
      <div class="pop-legend-caption">change in people / km²</div>
    </div>`;

  function changeScoreRow() {
    function delta(suffix) {
      const v2020 = indexEntry?.[`pop_2020_${suffix}`];
      const v1975 = indexEntry?.[`pop_1975_${suffix}`];
      if (v2020 == null || v1975 == null) return null;
      return v2020 - v1975;
    }
    function fmt(d) {
      if (d == null) return '—';
      return `${d >= 0 ? '+' : ''}${Math.round(d).toLocaleString()}\u202f/km²`;
    }
    function cls(d) {
      return d == null ? '' : d > 0 ? ' bu-score-up' : d < 0 ? ' bu-score-down' : '';
    }
    const d1km = delta('1km'), d5km = delta('5km'), d20km = delta('20km');
    return `
      <div class="pop-score-col">
        ${popChangeLegend}
        <div class="detail-bu-scores">
          <span class="bu-score"><span class="bu-score-label">Δ 1 km</span><span class="bu-score-value${cls(d1km)}">${_esc(fmt(d1km))}</span></span>
          <span class="bu-score"><span class="bu-score-label">Δ 5 km</span><span class="bu-score-value${cls(d5km)}">${_esc(fmt(d5km))}</span></span>
          <span class="bu-score"><span class="bu-score-label">Δ 20 km</span><span class="bu-score-value${cls(d20km)}">${_esc(fmt(d20km))}</span></span>
        </div>
      </div>`;
  }

  function scoreRightCol(prefix) {
    return `
      <div class="pop-score-col">
        ${legend}
        ${scoreRow(prefix)}
      </div>`;
  }

  const tabs = `
    <div class="bu-tabs" role="tablist" aria-label="Population year">
      <button class="pop-tab active" role="tab" data-tab="2020" aria-selected="true">2020</button>
      ${has1975 ? `<button class="pop-tab" role="tab" data-tab="1975" aria-selected="false">1975</button>` : ''}
      ${hasChange ? `<button class="pop-tab" role="tab" data-tab="change" aria-selected="false">Change</button>` : ''}
    </div>`;

  const panel2020 = style2020 ? `
    <div class="pop-tab-panel" data-panel="2020">
      ${_buMapWrap(`<div class="detail-bu-map" style="${_esc(style2020)}" aria-label="Population density 2020 (20 km box)"></div>`)}
      ${scoreRightCol('2020')}
    </div>` : '';

  const panel1975 = has1975 ? `
    <div class="pop-tab-panel" data-panel="1975" hidden>
      ${_buMapWrap(`<div class="detail-bu-map" style="${_esc(style1975)}" aria-label="Population density 1975 (20 km box)"></div>`)}
      ${scoreRightCol('1975')}
    </div>` : '';

  const popDisplay = (pop2020?.cell ?? pop1975?.cell ?? 32) * BU_ZOOM;
  const panelChange = hasChange ? `
    <div class="pop-tab-panel" data-panel="change" hidden>
      ${_buMapWrap(`<canvas class="detail-bu-change-canvas" width="${popDisplay}" height="${popDisplay}" style="width:${popDisplay}px;height:${popDisplay}px" aria-label="Population density change 1975–2020"></canvas>`)}
      ${changeScoreRow()}
    </div>` : '';

  return `
    <div class="detail-bu">
      ${tabs}
      <div class="bu-tab-panels">
        ${panel2020}${panel1975}${panelChange}
      </div>
    </div>`;
}

// ── BU palette inversion ──────────────────────────────────────────────────────
//
// Palette stops [built_up_fraction, R, G, B] — mirrors generate_bu_tiles.py.
// Each pixel's RGB is mapped back to a built-up fraction by finding the two
// nearest stops in RGB-space and applying inverse-distance weighting.
// This is necessary because no single channel is monotonic across the full
// palette: R−B, for instance, is inverted in the blue (0–2%) region.

const _BU_PALETTE = [
  [0.000,  8,  48, 107],
  [0.003, 29,  78, 137],
  [0.010, 33, 113, 181],
  [0.020, 86, 177, 247],
  [0.030, 247, 209,  61],
  [0.060, 248, 150,  30],
  [0.120, 220,  47,   2],
  [0.500, 157,   2,   8],
];

/**
 * Recover the approximate built-up fraction (0–0.5) for a sprite pixel by
 * finding the two closest palette stops in RGB-space and interpolating.
 */
function _buPixelValue(r, g, b) {
  let d0 = Infinity, d1 = Infinity, i0 = 0, i1 = 1;
  for (let i = 0; i < _BU_PALETTE.length; i++) {
    const dr = r - _BU_PALETTE[i][1];
    const dg = g - _BU_PALETTE[i][2];
    const db = b - _BU_PALETTE[i][3];
    const d  = dr * dr + dg * dg + db * db;
    if (d < d0) { d1 = d0; i1 = i0; d0 = d; i0 = i; }
    else if (d < d1) { d1 = d; i1 = i; }
  }
  const w0 = 1 / (Math.sqrt(d0) + 1e-6);
  const w1 = 1 / (Math.sqrt(d1) + 1e-6);
  return (_BU_PALETTE[i0][0] * w0 + _BU_PALETTE[i1][0] * w1) / (w0 + w1);
}

// ── Pop palette inversion ─────────────────────────────────────────────────────
//
// Palette stops [density_fraction, R, G, B] — mirrors generate_pop_tiles.py.
// density_fraction = density_people_per_km2 / MAX_POP_DENSITY (10 000).

const _POP_PALETTE = [
  [0.0000,  15,  15,  25],
  [0.0001,  25,  40, 100],
  [0.0010,  45,  85, 175],
  [0.0050,  55, 150, 175],
  [0.0200,  80, 190, 110],
  [0.0500, 195, 205,  60],
  [0.2000, 240, 130,  30],
  [0.5000, 220,  20,  10],
  [1.0000, 180,   0,   8],
];

function _popPixelValue(r, g, b) {
  let d0 = Infinity, d1 = Infinity, i0 = 0, i1 = 1;
  for (let i = 0; i < _POP_PALETTE.length; i++) {
    const dr = r - _POP_PALETTE[i][1];
    const dg = g - _POP_PALETTE[i][2];
    const db = b - _POP_PALETTE[i][3];
    const d  = dr * dr + dg * dg + db * db;
    if (d < d0) { d1 = d0; i1 = i0; d0 = d; i0 = i; }
    else if (d < d1) { d1 = d; i1 = i; }
  }
  const w0 = 1 / (Math.sqrt(d0) + 1e-6);
  const w1 = 1 / (Math.sqrt(d1) + 1e-6);
  return (_POP_PALETTE[i0][0] * w0 + _POP_PALETTE[i1][0] * w1) / (w0 + w1);
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

    // Pass 1: compute diffs and find the 95th-percentile absolute diff for
    // adaptive scaling — at most ~5% of pixels will be fully saturated.
    const n     = d2020.length / 4;
    const diffs = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const i = j * 4;
      diffs[j] = _buPixelValue(d2020[i], d2020[i + 1], d2020[i + 2])
               - _buPixelValue(d1975[i], d1975[i + 1], d1975[i + 2]);
    }
    const absSorted = Float32Array.from(diffs, Math.abs).sort();
    const scaleMax  = Math.max(0.005, absSorted[Math.floor(0.95 * n)]);
    const SCALE     = 255 / scaleMax;
    const DEAD_ZONE = scaleMax * 0.02;

    // Update legend labels with the actual scale value.
    const buPanel = canvas.closest('.bu-tab-panel');
    const pctStr  = `${(scaleMax * 100).toFixed(1)}%`;
    if (buPanel) {
      buPanel.querySelector('.change-label-low').textContent  = `−${pctStr}`;
      buPanel.querySelector('.change-label-high').textContent = `+${pctStr}`;
    }

    // Pass 2: render.
    for (let j = 0; j < n; j++) {
      const i    = j * 4;
      const diff = diffs[j];
      if (diff > DEAD_ZONE) {
        const mag = Math.min(255, diff * SCALE);
        out[i] = mag; out[i + 1] = 0; out[i + 2] = 0;
      } else if (diff < -DEAD_ZONE) {
        const mag = Math.min(255, -diff * SCALE);
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

async function _renderPopChangeCanvas(canvas) {
  if (!canvas || !_currentIndexEntry || !_currentBuSprites) return;
  const { pop2020, pop1975 } = _currentBuSprites;
  if (!pop2020 || !pop1975) return;

  const idx2020 = _currentIndexEntry.pop_2020_idx;
  const idx1975 = _currentIndexEntry.pop_1975_idx;
  if (idx2020 == null || idx1975 == null) return;

  const cell    = pop2020.cell;
  const display = cell * BU_ZOOM;

  try {
    const [img2020, img1975] = await Promise.all([
      _loadImg('assets/pop_2020_sprite.png'),
      _loadImg('assets/pop_1975_sprite.png'),
    ]);

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

    const d2020 = draw(img2020, pop2020, idx2020);
    const d1975 = draw(img1975, pop1975, idx1975);

    canvas.width  = display;
    canvas.height = display;
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(display, display);
    const out     = imgData.data;

    // Pass 1: compute diffs and find the 95th-percentile absolute diff for
    // adaptive scaling — at most ~5% of pixels will be fully saturated.
    const n     = d2020.length / 4;
    const diffs = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const i = j * 4;
      diffs[j] = _popPixelValue(d2020[i], d2020[i + 1], d2020[i + 2])
               - _popPixelValue(d1975[i], d1975[i + 1], d1975[i + 2]);
    }
    const absSorted = Float32Array.from(diffs, Math.abs).sort();
    const scaleMax  = Math.max(0.005, absSorted[Math.floor(0.95 * n)]);
    const SCALE     = 255 / scaleMax;
    const DEAD_ZONE = scaleMax * 0.02;

    // Update legend labels with the actual scale value (convert fraction → people/km²).
    const popPanel  = canvas.closest('.pop-tab-panel');
    const densityStr = Math.round(scaleMax * 10_000).toLocaleString();
    if (popPanel) {
      popPanel.querySelector('.change-label-low').textContent  = `−${densityStr}/km²`;
      popPanel.querySelector('.change-label-high').textContent = `+${densityStr}/km²`;
    }

    // Pass 2: render.
    for (let j = 0; j < n; j++) {
      const i    = j * 4;
      const diff = diffs[j];
      if (diff > DEAD_ZONE) {
        const mag = Math.min(255, diff * SCALE);
        out[i] = mag; out[i + 1] = 0; out[i + 2] = 0;
      } else if (diff < -DEAD_ZONE) {
        const mag = Math.min(255, -diff * SCALE);
        out[i] = 0; out[i + 1] = 0; out[i + 2] = mag;
      } else {
        out[i] = 18; out[i + 1] = 18; out[i + 2] = 18;
      }
      out[i + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
  } catch (err) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, display, display);
    ctx.fillStyle = '#5a6880';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('1975 sprite not yet', display / 2, display / 2 - 8);
    ctx.fillText('generated — run:', display / 2, display / 2 + 8);
    ctx.fillText('generate_pop_tiles.py --year 1975', display / 2, display / 2 + 24);
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
    ${_renderDataSections(indexEntry, buSprites)}
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
    ${_renderDataSections(indexEntry, buSprites)}
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
