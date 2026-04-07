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

import { renderQR } from './qr.js?v=20260406';
import { serialiseStationState, pushState } from './url-state.js?v=20260406';
import { trackEvent } from './analytics.js?v=20260406';
import { TempChart, MONTHS, MONTH_DASH, BYMONTH_DEFAULT_MASK } from './temp-chart.js?v=20260406';
import { AdjChart } from './adj-chart.js?v=20260406';
import { renderSourcesContent } from './sources-panel.js?v=20260406';

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

export function preloadDetailSprites(sprites = null) {
  const sources = [];
  if (sprites?.bu2020) sources.push('assets/bu_2020_sprite.png');
  if (sprites?.bu1975) sources.push('assets/bu_1975_sprite.png');
  if (sprites?.pop2020) sources.push('assets/pop_2020_sprite.png');
  if (sprites?.pop1975) sources.push('assets/pop_1975_sprite.png');
  sources.forEach(src => { _loadImg(src).catch(() => {}); });
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
let _headerTooltipResizeHandler = null;
let _printRoot = null;
let _printCharts = [];
let _detailRawCsv = { qcu: null, qcf: null };

/** Current index entry and sprite descriptors, used by the change-canvas renderer. */
let _currentIndexEntry = null;
let _currentBuSprites  = null;
let _currentLocationId = null;
let _headerMetaMediaQuery = null;
let _headerMetaMediaHandler = null;

/** Active TempChart instances keyed by section name. Destroyed on panel close. */
let _charts = {};

/** Shared chart mode across both temp sections (kept in sync). */
let _sharedChartMode = 'monthly';

/** Shared partial-year estimate visibility (line + dots) across both temp sections. */
let _sharedShowEst = true;

/** Shared 95% CI error-bar visibility across both temp sections (requires _sharedShowEst). */
let _sharedShowCI = true;

/** Shared bymonth selected-months set across both temp sections. */
let _sharedSelectedMonths = new Set([0, 6]);

/** Shared annual anomaly toggle: exclude years with fewer than 9 months. */
let _sharedExcludeSparseAnomalyYears = true;

/** Shared annual anomaly toggle: reference anomaly to the 30 full years nearest the record centre. */
let _sharedUseCenteredAnomalyReference = false;

/** Shared annual anomaly toggle: show the anomaly trend line. */
let _sharedShowAnomalyTrend = true;

/** Shared LOESS smooth-line toggle. */
let _sharedShowLoess = false;

/** Shared LOESS bandwidth span (0.1–0.9). */
let _sharedLoessSpan = 0.3;

/** Current mode for the Adjustments chart (independent of temp chart mode). */
let _adjMode = 'monthly';

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
      // Render station QR code into all .qr-code containers (header + about tab).
      const stationUrl =
        `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
      _panel.querySelectorAll('.qr-code').forEach(el => renderQR(stationUrl, el, 100));
    })
    .catch(() => {
      // No detail JSON — show what we know from the index entry.
      _panel.innerHTML = _renderIndexDetail(locationId, indexEntry, buSprites);
      _attachHandlers();
      const stationUrl =
        `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(locationId)}`;
      _panel.querySelectorAll('.qr-code').forEach(el => renderQR(stationUrl, el, 100));
    });
}

/**
 * Close the detail panel, restore the appropriate view URL hash, and notify
 * app.js which view to return to via the 'detail:closed' event.
 */
export function closeDetail() {
  if (!_overlay) return;
  _destroyCharts();
  if (_headerTooltipResizeHandler) {
    window.removeEventListener('resize', _headerTooltipResizeHandler);
    _headerTooltipResizeHandler = null;
  }
  if (_headerMetaMediaQuery && _headerMetaMediaHandler) {
    _headerMetaMediaQuery.removeEventListener('change', _headerMetaMediaHandler);
    _headerMetaMediaQuery = null;
    _headerMetaMediaHandler = null;
  }
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
  _detailRawCsv = { qcu: null, qcf: null };
}

function _applyChartModeUi(section, mode) {
  _panel.querySelectorAll(`[data-section="${section}"] .chart-mode-btn`).forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const modeRow = _panel.querySelector(`[data-section="${section}"] .chart-mode-row`);
  modeRow?._updateArrows?.();

  const partialControls = _panel.querySelector(`[data-section="${section}"] .chart-partial-controls`);
  if (partialControls) partialControls.hidden = mode !== 'yearly';

  const monthToggles = _panel.querySelector(`[data-section="${section}"] .chart-month-toggles`);
  if (monthToggles) monthToggles.hidden = mode !== 'bymonth';

  const anomalyControls = _panel.querySelector(`[data-section="${section}"] .chart-anomaly-controls`);
  if (anomalyControls) anomalyControls.hidden = mode !== 'anomaly';

  const trendControls = _panel.querySelector(`[data-section="${section}"] .chart-trend-controls`);
  if (trendControls) trendControls.hidden = mode === 'heatmap';

  const chartFooter = _panel.querySelector(`[data-section="${section}"] .chart-footer`);
  if (chartFooter) chartFooter.hidden = mode === 'heatmap';

  const hint = _panel.querySelector(`[data-section="${section}"] .chart-hint`);
  if (hint) {
    hint.style.visibility = mode === 'bymonth' ? 'hidden' : 'visible';
    if (mode !== 'bymonth') {
      hint.textContent = mode === 'anomaly'
        ? 'Drag to pan · Hover for anomaly'
        : 'Drag to pan · Hover for temperature';
    }
  }

  const loessControls = _panel.querySelector(`[data-section="${section}"] .chart-loess-controls`);
  if (loessControls) loessControls.style.visibility = (_sharedShowLoess && mode !== 'heatmap') ? 'visible' : 'hidden';
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

  // Restore partial-year visibility from URL state.
  if (restore?.showEst != null) _sharedShowEst = restore.showEst;
  if (restore?.showCI  != null) _sharedShowCI  = restore.showCI;

  // Restore bymonth selection.
  if (restore?.selectedMonths != null) _sharedSelectedMonths = new Set(restore.selectedMonths);
  if (restore?.excludeSparseAnomalyYears != null) {
    _sharedExcludeSparseAnomalyYears = restore.excludeSparseAnomalyYears;
  }
  if (restore?.useCenteredAnomalyReference != null) {
    _sharedUseCenteredAnomalyReference = restore.useCenteredAnomalyReference;
  }
  if (restore?.showAnomalyTrend != null) {
    _sharedShowAnomalyTrend = restore.showAnomalyTrend;
  }
  if (restore?.showLoess != null) {
    _sharedShowLoess = restore.showLoess;
  }
  if (restore?.loessSpan != null) {
    _sharedLoessSpan = restore.loessSpan;
  }

  // Initialise the Adjustments chart.
  const adjWrap = _panel.querySelector(`[data-section="adj"] .chart-canvas-wrap`);
  const adjChart = adjWrap ? new AdjChart(adjWrap) : null;
  if (adjChart) _charts['adj'] = adjChart;

  // Restore adj mode from URL if the adj section was active.
  if (restore?.section === 'adj' && restore?.mode) {
    _adjMode = restore.mode;
    adjChart?.setMode(_adjMode);
    _panel.querySelectorAll('[data-section="adj"] [data-adj-mode]').forEach(b => {
      const active = b.dataset.adjMode === _adjMode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    _panel.querySelector('[data-section="adj"] .chart-mode-row')?._updateArrows?.();
  }

  // Wire adj mode buttons.
  _panel.querySelectorAll('[data-section="adj"] [data-adj-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      _adjMode = btn.dataset.adjMode;
      adjChart?.setMode(_adjMode);
      _panel.querySelectorAll('[data-section="adj"] [data-adj-mode]').forEach(b => {
        const active = b.dataset.adjMode === _adjMode;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      _panel.querySelector('[data-section="adj"] .chart-mode-row')?._updateArrows?.();
      _updateStationUrl();
    });
  });

  // Wire adj zoom buttons.
  _panel.querySelectorAll('[data-section="adj"] .chart-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'zoom-in')    adjChart?.zoomIn();
      if (action === 'zoom-out')   adjChart?.zoomOut();
      if (action === 'zoom-reset') adjChart?.resetZoom();
    });
  });

  // Propagate adj zoom changes to URL.
  adjWrap?.addEventListener('chart:zoom', () => _updateStationUrl());

  // Track data-load completion so we can compute the cross-chart union range.
  // Raw CSV texts are stored so we can feed both to AdjChart once both have loaded.
  _detailRawCsv = { qcu: null, qcf: null };
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

    // Apply the union range to all temp charts.
    for (const s of SECTIONS) {
      const c = _charts[s];
      if (!c) continue;
      c.setGlobalRange(globalMin, globalMax);
      if (restore?.zoomMin != null && restore.zoomMax != null) {
        c.setZoom(restore.zoomMin, restore.zoomMax);
      }
    }

    // Feed both datasets to the adj chart and give it the same x range.
    if (adjChart && _detailRawCsv.qcu !== null && _detailRawCsv.qcf !== null) {
      adjChart.load(_detailRawCsv.qcu, _detailRawCsv.qcf);
      adjChart.setGlobalRange(globalMin, globalMax);
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
    }
    _applyChartModeUi(section, _sharedChartMode);

    // Apply restored Est. / CI button states.
    const estBtn = _panel.querySelector(`[data-section="${section}"] [data-action="est-toggle"]`);
    const ciBtn  = _panel.querySelector(`[data-section="${section}"] [data-action="ci-toggle"]`);
    if (estBtn) {
      estBtn.classList.toggle('active', _sharedShowEst);
      estBtn.setAttribute('aria-pressed', String(_sharedShowEst));
    }
    if (ciBtn) {
      ciBtn.classList.toggle('active', _sharedShowCI);
      ciBtn.setAttribute('aria-pressed', String(_sharedShowCI));
      ciBtn.disabled = !_sharedShowEst;
    }
    chart.setShowEst(_sharedShowEst);
    chart.setShowCI(_sharedShowCI);
    chart.setSelectedMonths(new Set(_sharedSelectedMonths));

    // Apply restored bymonth button states.
    _panel.querySelectorAll(`[data-section="${section}"] .month-toggle-btn`).forEach(btn => {
      const m = parseInt(btn.dataset.month, 10);
      const active = _sharedSelectedMonths.has(m);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    chart.setExcludeSparseAnomalyYears(_sharedExcludeSparseAnomalyYears);
    chart.setUseCenteredAnomalyReference(_sharedUseCenteredAnomalyReference);
    chart.setShowAnomalyTrend(_sharedShowAnomalyTrend);

    const sparseBtn = _panel.querySelector(`[data-section="${section}"] [data-action="anomaly-sparse-toggle"]`);
    const refBtn    = _panel.querySelector(`[data-section="${section}"] [data-action="anomaly-ref-toggle"]`);
    const trendBtn  = _panel.querySelector(`[data-section="${section}"] [data-action="trend-toggle"]`);
    if (sparseBtn) {
      sparseBtn.classList.toggle('active', _sharedExcludeSparseAnomalyYears);
      sparseBtn.setAttribute('aria-pressed', String(_sharedExcludeSparseAnomalyYears));
    }
    if (refBtn) {
      refBtn.classList.toggle('active', _sharedUseCenteredAnomalyReference);
      refBtn.setAttribute('aria-pressed', String(_sharedUseCenteredAnomalyReference));
    }
    if (trendBtn) {
      trendBtn.classList.toggle('active', _sharedShowAnomalyTrend);
      trendBtn.setAttribute('aria-pressed', String(_sharedShowAnomalyTrend));
    }

    // Apply initial LOESS state.
    const loessBtn = _panel.querySelector(`[data-section="${section}"] [data-action="loess-toggle"]`);
    if (loessBtn) {
      loessBtn.classList.toggle('active', _sharedShowLoess);
      loessBtn.setAttribute('aria-pressed', String(_sharedShowLoess));
    }
    chart.setShowLoess(_sharedShowLoess);
    chart.setLoessSpan(_sharedLoessSpan);

    // Apply initial loess-controls visibility.
    const loessCtrl = _panel.querySelector(`[data-section="${section}"] .chart-loess-controls`);
    if (loessCtrl) loessCtrl.style.visibility = _sharedShowLoess ? 'visible' : 'hidden';
    // Sync slider value display.
    const loessRange = _panel.querySelector(`[data-section="${section}"] .loess-range`);
    const loessVal   = _panel.querySelector(`[data-section="${section}"] .loess-slider-value`);
    if (loessRange) loessRange.value = Math.round(_sharedLoessSpan * 100);
    if (loessVal)   loessVal.textContent = _sharedLoessSpan.toFixed(2);

    fetch(`data/${PATHS[i]}/${encodeURIComponent(locationId)}.csv`)
      .then(r => r.ok ? r.text() : '')
      .catch(() => '')
      .then(text => {
        chart.load(text);
        _detailRawCsv[PATHS[i]] = text;
        _onChartDataLoaded();
      });

    // Mode toggle buttons — sync across both temp sections.
    _panel.querySelectorAll(`[data-section="${section}"] .chart-mode-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        _sharedChartMode = mode;
        SECTIONS.forEach(s => {
          _applyChartModeUi(s, mode);
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

    // Est. toggle — show/hide partial-year estimate line + dots; also disables CI btn.
    _panel.querySelector(`[data-section="${section}"] [data-action="est-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedShowEst = !_sharedShowEst;
        SECTIONS.forEach(s => {
          _charts[s]?.setShowEst(_sharedShowEst);
          const eb = _panel.querySelector(`[data-section="${s}"] [data-action="est-toggle"]`);
          if (eb) { eb.classList.toggle('active', _sharedShowEst); eb.setAttribute('aria-pressed', String(_sharedShowEst)); }
          const cb = _panel.querySelector(`[data-section="${s}"] [data-action="ci-toggle"]`);
          if (cb) cb.disabled = !_sharedShowEst;
        });
        _updateStationUrl();
      });

    // CI toggle — show/hide 95% error bars (requires Est. to be on).
    _panel.querySelector(`[data-section="${section}"] [data-action="ci-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedShowCI = !_sharedShowCI;
        SECTIONS.forEach(s => {
          _charts[s]?.setShowCI(_sharedShowCI);
          const cb = _panel.querySelector(`[data-section="${s}"] [data-action="ci-toggle"]`);
          if (cb) { cb.classList.toggle('active', _sharedShowCI); cb.setAttribute('aria-pressed', String(_sharedShowCI)); }
        });
        _updateStationUrl();
      });

    // Month toggle buttons — sync selection across both temp sections.
    _panel.querySelectorAll(`[data-section="${section}"] .month-toggle-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        const m = parseInt(btn.dataset.month, 10);
        if (_sharedSelectedMonths.has(m)) _sharedSelectedMonths.delete(m);
        else _sharedSelectedMonths.add(m);
        SECTIONS.forEach(s => {
          _charts[s]?.setSelectedMonths(new Set(_sharedSelectedMonths));
          _panel.querySelectorAll(`[data-section="${s}"] .month-toggle-btn`).forEach(b => {
            const bm     = parseInt(b.dataset.month, 10);
            const active = _sharedSelectedMonths.has(bm);
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', String(active));
          });
        });
        _updateStationUrl();
      });
    });

    _panel.querySelector(`[data-section="${section}"] [data-action="anomaly-sparse-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedExcludeSparseAnomalyYears = !_sharedExcludeSparseAnomalyYears;
        SECTIONS.forEach(s => {
          _charts[s]?.setExcludeSparseAnomalyYears(_sharedExcludeSparseAnomalyYears);
          const b = _panel.querySelector(`[data-section="${s}"] [data-action="anomaly-sparse-toggle"]`);
          if (b) {
            b.classList.toggle('active', _sharedExcludeSparseAnomalyYears);
            b.setAttribute('aria-pressed', String(_sharedExcludeSparseAnomalyYears));
          }
        });
        _updateStationUrl();
      });

    _panel.querySelector(`[data-section="${section}"] [data-action="anomaly-ref-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedUseCenteredAnomalyReference = !_sharedUseCenteredAnomalyReference;
        SECTIONS.forEach(s => {
          _charts[s]?.setUseCenteredAnomalyReference(_sharedUseCenteredAnomalyReference);
          const b = _panel.querySelector(`[data-section="${s}"] [data-action="anomaly-ref-toggle"]`);
          if (b) {
            b.classList.toggle('active', _sharedUseCenteredAnomalyReference);
            b.setAttribute('aria-pressed', String(_sharedUseCenteredAnomalyReference));
          }
        });
        _updateStationUrl();
      });

    _panel.querySelector(`[data-section="${section}"] [data-action="trend-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedShowAnomalyTrend = !_sharedShowAnomalyTrend;
        SECTIONS.forEach(s => {
          _charts[s]?.setShowAnomalyTrend(_sharedShowAnomalyTrend);
          const b = _panel.querySelector(`[data-section="${s}"] [data-action="trend-toggle"]`);
          if (b) {
            b.classList.toggle('active', _sharedShowAnomalyTrend);
            b.setAttribute('aria-pressed', String(_sharedShowAnomalyTrend));
          }
        });
        _updateStationUrl();
      });

    // LOESS toggle.
    _panel.querySelector(`[data-section="${section}"] [data-action="loess-toggle"]`)
      ?.addEventListener('click', () => {
        _sharedShowLoess = !_sharedShowLoess;
        SECTIONS.forEach(s => {
          _charts[s]?.setShowLoess(_sharedShowLoess);
          const b = _panel.querySelector(`[data-section="${s}"] [data-action="loess-toggle"]`);
          if (b) { b.classList.toggle('active', _sharedShowLoess); b.setAttribute('aria-pressed', String(_sharedShowLoess)); }
          const lc = _panel.querySelector(`[data-section="${s}"] .chart-loess-controls`);
          if (lc) lc.style.visibility = _sharedShowLoess ? 'visible' : 'hidden';
        });
        _updateStationUrl();
      });

    // LOESS span slider.
    _panel.querySelector(`[data-section="${section}"] .loess-range`)
      ?.addEventListener('input', (e) => {
        _sharedLoessSpan = parseInt(e.target.value, 10) / 100;
        SECTIONS.forEach(s => {
          _charts[s]?.setLoessSpan(_sharedLoessSpan);
          const r = _panel.querySelector(`[data-section="${s}"] .loess-range`);
          const v = _panel.querySelector(`[data-section="${s}"] .loess-slider-value`);
          if (r) r.value = e.target.value;
          if (v) v.textContent = _sharedLoessSpan.toFixed(2);
        });
        _updateStationUrl();
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
  const headerTooltip = _panel.querySelector('.detail-header-tooltip');
  let headerTooltipTimer = null;
  let headerStatusVisible = false;

  function setHeaderTooltipMessage(message) {
    if (headerTooltip) headerTooltip.textContent = message;
  }

  function positionHeaderTooltip(target) {
    if (!headerTooltip || !target) return;
    const rect = target.getBoundingClientRect();
    const ttW = headerTooltip.offsetWidth || 140;
    const ttH = headerTooltip.offsetHeight || 32;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - ttW / 2, window.innerWidth - ttW - 8));
    const top = Math.max(8, rect.bottom + 8);
    headerTooltip.style.left = `${left}px`;
    headerTooltip.style.top = `${Math.min(top, window.innerHeight - ttH - 8)}px`;
  }

  function showHeaderTooltip(target, duration = null) {
    if (!headerTooltip || !target) return;
    globalThis.clearTimeout(headerTooltipTimer);
    headerTooltip.hidden = false;
    positionHeaderTooltip(target);
    if (duration != null) {
      headerTooltipTimer = globalThis.setTimeout(() => {
        headerTooltip.hidden = true;
        headerStatusVisible = false;
      }, duration);
    }
  }

  function hideHeaderTooltip() {
    if (!headerTooltip) return;
    globalThis.clearTimeout(headerTooltipTimer);
    headerTooltip.hidden = true;
    headerStatusVisible = false;
  }

  function showHeaderStatus(target, message, duration = 1600) {
    headerStatusVisible = true;
    setHeaderTooltipMessage(message);
    showHeaderTooltip(target, duration);
  }

  function bindHeaderTooltip(selector, message) {
    const btn = _panel.querySelector(selector);
    if (!btn) return null;
    btn.addEventListener('mouseenter', () => {
      if (headerStatusVisible) return;
      setHeaderTooltipMessage(message);
      showHeaderTooltip(btn);
    });
    btn.addEventListener('mouseleave', () => {
      if (headerStatusVisible) return;
      hideHeaderTooltip();
    });
    btn.addEventListener('focus', () => {
      if (headerStatusVisible) return;
      setHeaderTooltipMessage(message);
      showHeaderTooltip(btn);
    });
    btn.addEventListener('blur', () => {
      if (headerStatusVisible) return;
      hideHeaderTooltip();
    });
    btn.addEventListener('touchstart', () => {
      if (headerStatusVisible) return;
      setHeaderTooltipMessage(message);
      showHeaderTooltip(btn, 1800);
    }, { passive: true });
    return btn;
  }

  closeBtn?.addEventListener('click', closeDetail);
  closeBtn?.focus();

  const shareBtn = bindHeaderTooltip('.detail-share-btn', 'Copy link to clipboard');
  bindHeaderTooltip('.detail-download-btn', 'Download');
  bindHeaderTooltip('.detail-close', 'Close');
  if (_headerTooltipResizeHandler) window.removeEventListener('resize', _headerTooltipResizeHandler);
  _headerTooltipResizeHandler = () => {
    const active = document.activeElement;
    if (!headerTooltip?.hidden && active?.classList?.contains('detail-action-btn')) {
      positionHeaderTooltip(active);
    }
  };
  window.addEventListener('resize', _headerTooltipResizeHandler);

  const nameToggle = _panel.querySelector('.detail-name-toggle');
  const headerMeta = _panel.querySelector('.detail-header-meta');
  const setHeaderMetaExpanded = expanded => {
    if (!nameToggle || !headerMeta) return;
    nameToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) headerMeta.removeAttribute('hidden');
    else headerMeta.setAttribute('hidden', '');
  };
  if (nameToggle && headerMeta) {
    _headerMetaMediaQuery = window.matchMedia('(max-width: 834px)');
    _headerMetaMediaHandler = e => setHeaderMetaExpanded(!e.matches);
    setHeaderMetaExpanded(!_headerMetaMediaQuery.matches);
    _headerMetaMediaQuery.addEventListener('change', _headerMetaMediaHandler);
    nameToggle.addEventListener('click', () => {
      if (!_headerMetaMediaQuery?.matches) return;
      const expanded = nameToggle.getAttribute('aria-expanded') === 'true';
      setHeaderMetaExpanded(!expanded);
    });
  }

  // Share button — copy current URL to clipboard.
  shareBtn?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const result = await _copyText(window.location.href);
    showHeaderStatus(btn, result.ok ? 'Copied link' : result.message, result.ok ? 1600 : 2600);
  });

  // Download button — toggle the download menu.
  const dlBtn  = _panel.querySelector('.detail-download-btn');
  const dlMenu = _panel.querySelector('.detail-download-menu');
  if (dlBtn && dlMenu) {
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dlMenu.hidden = !dlMenu.hidden;
    });
    dlMenu.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-dl]');
      if (!opt) return;
      dlMenu.hidden = true;
      if (opt.dataset.dl === 'png') _downloadPng();
      if (opt.dataset.dl === 'pdf') _printReport();
    });
    document.addEventListener('click', () => { dlMenu.hidden = true; }, { once: false, capture: false });
    _panel.addEventListener('click', (e) => {
      if (!e.target.closest('.detail-download-btn') && !e.target.closest('.detail-download-menu')) {
        dlMenu.hidden = true;
      }
    });
  }

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

  _initDetailMapMedia();
  _initTabScrollArrows();
  _initModeArrows();

  // Initialize temperature charts (must be after DOM is ready).
  _initCharts();
}

async function _copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, message: 'Copied link' };
    }
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Clipboard permission was denied.'
      : 'Clipboard API copy failed.';
    return _legacyCopyText(text, msg);
  }

  return _legacyCopyText(text, 'Clipboard API unavailable.');
}

function _legacyCopyText(text, fallbackReason) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {}

  ta.remove();
  return copied
    ? { ok: true, message: 'Copied link' }
    : { ok: false, message: fallbackReason === 'Clipboard API unavailable.'
      ? 'Copy is not supported in this browser.'
      : 'Copy failed. Browser blocked clipboard access.' };
}

function _initTabScrollArrows() {
  const wrap = _panel.querySelector('.section-tabs-wrap');
  if (!wrap) return;
  const tabs = wrap.querySelector('.section-tabs');
  const btnL = wrap.querySelector('.tabs-scroll-left');
  const btnR = wrap.querySelector('.tabs-scroll-right');
  if (!tabs || !btnL || !btnR) return;

  function getTabBtns() { return [...tabs.querySelectorAll('.section-tab')]; }
  function getActiveIdx() { return getTabBtns().findIndex(t => t.classList.contains('active')); }

  function updateArrows() {
    const idx   = getActiveIdx();
    const total = getTabBtns().length;
    btnL.hidden = idx <= 0;
    btnR.hidden = idx >= total - 1;
    tabs.querySelector('.section-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  btnL.addEventListener('click', () => {
    const idx = getActiveIdx();
    if (idx > 0) _switchSectionTab(getTabBtns()[idx - 1].dataset.section);
  });
  btnR.addEventListener('click', () => {
    const idx = getActiveIdx();
    const btns = getTabBtns();
    if (idx < btns.length - 1) _switchSectionTab(btns[idx + 1].dataset.section);
  });

  _panel._updateTabArrows = updateArrows;
  requestAnimationFrame(updateArrows);
}

function _initModeArrows() {
  _panel.querySelectorAll('.chart-mode-row').forEach(modeRow => {
    const toggle  = modeRow.querySelector('.chart-mode-toggle');
    const prevBtn = modeRow.querySelector('.chart-mode-prev');
    const nextBtn = modeRow.querySelector('.chart-mode-next');
    if (!toggle || !prevBtn || !nextBtn) return;

    function getModeBtns() { return [...toggle.querySelectorAll('.chart-mode-btn')]; }
    function getActiveIdx() { return getModeBtns().findIndex(b => b.classList.contains('active')); }

    function updateArrows() {
      const idx   = getActiveIdx();
      const total = getModeBtns().length;
      prevBtn.hidden = idx <= 0;
      nextBtn.hidden = idx >= total - 1;
    }

    prevBtn.addEventListener('click', () => {
      const idx = getActiveIdx();
      if (idx > 0) getModeBtns()[idx - 1].click();
    });
    nextBtn.addEventListener('click', () => {
      const idx = getActiveIdx();
      const btns = getModeBtns();
      if (idx < btns.length - 1) btns[idx + 1].click();
    });

    modeRow._updateArrows = updateArrows;
    requestAnimationFrame(updateArrows);
  });
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

  _panel._updateTabArrows?.();
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
          _renderDetailMapCanvas(canvas, renderChangeFn);
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
    detail.mode            = _sharedChartMode;
    detail.showEst         = _sharedShowEst;
    detail.showCI          = _sharedShowCI;
    detail.selectedMonths  = _sharedSelectedMonths;
    detail.excludeSparseAnomalyYears = _sharedExcludeSparseAnomalyYears;
    detail.useCenteredAnomalyReference = _sharedUseCenteredAnomalyReference;
    detail.showAnomalyTrend = _sharedShowAnomalyTrend;
    detail.showLoess  = _sharedShowLoess;
    detail.loessSpan  = _sharedLoessSpan;
    if (chart) {
      const zoom = chart.getZoom();
      detail.zoomMin = zoom?.min;
      detail.zoomMax = zoom?.max;
    }
  } else if (section === 'adj') {
    detail.mode = _adjMode;
  } else if (section === 'bu-surface' || section === 'population') {
    const yearTab = _panel.querySelector('.bu-tab.active') ??
                    _panel.querySelector('.pop-tab.active');
    detail.mode = yearTab?.dataset.tab;
  }

  pushState(serialiseStationState(_currentLocationId, detail));

  // Keep all detail panel QR codes in sync with the current shareable URL.
  _panel?.querySelectorAll('.qr-code').forEach(el => renderQR(window.location.href, el, 100));
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
    <div class="detail-map-loading" aria-hidden="true">
      <div class="detail-map-spinner"></div>
    </div>
    ${mapDiv}
    <div class="detail-bu-crosshair" aria-hidden="true"></div>
    <div class="detail-bu-scale" aria-hidden="true">
      <div class="scale-bar"></div>
      <div class="scale-label">5 km</div>
    </div>
  </div>`;
}

function _aboutPanel(data, indexEntry, locationId) {
  const description = data?.description ?? '';
  const vars = (data?.variables ?? [])
    .map(v => `<span class="variable-tag">${_esc(v)}</span>`)
    .join('');

  const metaItems = [];
  if (data?.country)     metaItems.push({ label: 'Country',     value: data.country });
  if (data?.established) metaItems.push({ label: 'Established', value: data.established });
  if (data?.network)     metaItems.push({ label: 'Network',     value: data.network });

  const metaHtml = metaItems.map(m => `
    <div class="meta-item">
      <span class="meta-label">${_esc(m.label)}</span>
      <span class="meta-value">${_esc(m.value)}</span>
    </div>`).join('');

  if (!description && !vars && !metaHtml) return '';

  return `
    <div class="about-section">
      ${description ? `<p class="about-description">${_esc(description)}</p>` : ''}
      ${vars ? `<div class="about-variables">${vars}</div>` : ''}
      ${metaHtml ? `<div class="detail-meta about-meta">${metaHtml}</div>` : ''}
    </div>`;
}

function _printSectionHeading(title) {
  return `<h2 class="print-section-title">${_esc(title)}</h2>`;
}

function _sectionPanel(section, title, content, { hidden = false, printOnly = false } = {}) {
  return `<div class="section-panel${printOnly ? ' print-only-panel' : ''}" data-section="${section}"${hidden ? ' hidden' : ''}>${_printSectionHeading(title)}${content}</div>`;
}

/**
 * Build the combined detail-sections block (temperature charts + Built-Up Surface + Population).
 * Temperature sections are always rendered. BU/Pop are omitted when no sprites are available.
 */
function _renderDataSections(data, indexEntry, locationId, sprites) {
  const aboutContent = _aboutPanel(data, indexEntry, locationId);
  const buContent  = _buSectionContent(indexEntry, sprites);
  const popContent = _popSectionContent(indexEntry, sprites);

  const tabs   = [];
  const panels = [];

  if (aboutContent) {
    tabs.push(`<button class="section-tab" role="tab" data-section="about" aria-selected="false">About</button>`);
    panels.push(_sectionPanel('about', 'About', aboutContent, { hidden: true }));
  }

  // Temperature charts — active by default
  tabs.push(`<button class="section-tab active" role="tab" data-section="temp-qcu" aria-selected="true">Unadjusted</button>`);
  tabs.push(`<button class="section-tab" role="tab" data-section="temp-qcf" aria-selected="false">Adjusted</button>`);
  tabs.push(`<button class="section-tab" role="tab" data-section="adj" aria-selected="false">Adjustments</button>`);
  panels.push(_sectionPanel('temp-qcu', 'Unadjusted', _tempChartPanel()));
  panels.push(_sectionPanel('temp-qcf', 'Adjusted', _tempChartPanel(), { hidden: true }));
  panels.push(_sectionPanel('adj', 'Adjustments', _adjChartPanel(), { hidden: true }));

  if (buContent) {
    tabs.push(`<button class="section-tab" role="tab" data-section="bu-surface" aria-selected="false">Built-Up</button>`);
    panels.push(_sectionPanel('bu-surface', 'Built-Up', buContent, { hidden: true }));
  }
  if (popContent) {
    tabs.push(`<button class="section-tab" role="tab" data-section="population" aria-selected="false">Population</button>`);
    panels.push(_sectionPanel('population', 'Population', popContent, { hidden: true }));
  }

  panels.push(_sectionPanel(
    'sources-methods',
    'Data Sources / Methods',
    `<div class="detail-print-sources">${renderSourcesContent({ includeShell: false })}</div>`,
    { hidden: true, printOnly: true }
  ));

  return `
    <div class="detail-sections">
      <div class="section-tabs-wrap">
        <button class="tabs-scroll-btn tabs-scroll-left" aria-label="Previous section" hidden>‹</button>
        <div class="section-tabs" role="tablist" aria-label="Detail sections">
          ${tabs.join('')}
        </div>
        <button class="tabs-scroll-btn tabs-scroll-right" aria-label="Next section" hidden>›</button>
      </div>
      ${panels.join('')}
    </div>`;
}

/** HTML scaffold for the Adjustments chart panel (AdjChart is initialised in _initCharts). */
function _adjChartPanel() {
  return `
    <div class="temp-chart-section">
      <div class="chart-mode-row">
        <button class="chart-mode-arrow chart-mode-prev" aria-label="Previous chart mode" hidden>‹</button>
        <div class="chart-mode-toggle" role="group" aria-label="Time resolution">
          <button class="chart-mode-btn active" data-adj-mode="monthly" aria-pressed="true">Monthly</button>
          <button class="chart-mode-btn" data-adj-mode="yearly" aria-pressed="false">Annual</button>
        </div>
        <button class="chart-mode-arrow chart-mode-next" aria-label="Next chart mode" hidden>›</button>
      </div>
      <div class="chart-controls-row">
        <div class="chart-zoom-controls" role="group" aria-label="Zoom controls">
          <button class="chart-zoom-btn" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="chart-zoom-btn" data-action="zoom-reset" title="Reset zoom" aria-label="Reset zoom">⊙</button>
          <button class="chart-zoom-btn" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="chart-canvas-wrap"></div>
      <div class="adj-series-toggles" role="group" aria-label="Adjustment series">
        <button class="adj-series-btn active" data-series="total" style="--s-color:var(--adj-total)" aria-pressed="true">Total</button>
        <button class="adj-series-btn" data-series="tob" style="--s-color:var(--adj-tob)" disabled title="TOB component coming soon" aria-pressed="false">TOB</button>
        <button class="adj-series-btn" data-series="pha" style="--s-color:var(--adj-pha)" disabled title="PHA component coming soon" aria-pressed="false">PHA</button>
      </div>
    </div>`;
}

/** Generate 12 month toggle buttons for bymonth mode. */
function _monthToggleButtons() {
  return MONTHS.map((name, i) => {
    const active = (BYMONTH_DEFAULT_MASK >> i) & 1 ? 'active' : '';
    const dash   = MONTH_DASH[i].length === 0 ? 'solid'
                 : MONTH_DASH[i][0] >= 5       ? 'dashed'
                 :                               'dotted';
    return `<button class="month-toggle-btn ${active}" data-month="${i}" data-dash="${dash}" style="--m-color:var(--month-${i})" aria-pressed="${active ? 'true' : 'false'}">${name}</button>`;
  }).join('');
}

/** HTML scaffold for a temperature chart panel (chart is initialised in _initCharts). */
function _tempChartPanel() {
  return `
    <div class="temp-chart-section">
      <div class="chart-mode-row">
        <button class="chart-mode-arrow chart-mode-prev" aria-label="Previous chart mode" hidden>‹</button>
        <div class="chart-mode-toggle" role="group" aria-label="Time resolution">
          <button class="chart-mode-btn active" data-mode="monthly" aria-pressed="true">Monthly</button>
          <button class="chart-mode-btn" data-mode="bymonth" aria-pressed="false">By Month</button>
          <button class="chart-mode-btn" data-mode="yearly" aria-pressed="false">Annual</button>
          <button class="chart-mode-btn" data-mode="heatmap" aria-pressed="false">Heatmap</button>
          <button class="chart-mode-btn" data-mode="anomaly" aria-pressed="false">Anomaly</button>
        </div>
        <button class="chart-mode-arrow chart-mode-next" aria-label="Next chart mode" hidden>›</button>
      </div>
      <div class="chart-controls-row">
        <div class="chart-partial-controls" hidden role="group" aria-label="Partial year options">
          <button class="chart-ci-btn active" data-action="est-toggle" title="Show/hide partial-year estimates" aria-pressed="true">Est.</button>
          <button class="chart-ci-btn active" data-action="ci-toggle" title="Show/hide 95% CI error bars" aria-pressed="true">95% CI</button>
        </div>
        <div class="chart-anomaly-controls" hidden role="group" aria-label="Annual anomaly options">
          <button class="chart-ci-btn active" data-action="anomaly-sparse-toggle" title="Exclude years with fewer than 9 months" aria-pressed="true">9+ mo</button>
          <button class="chart-ci-btn" data-action="anomaly-ref-toggle" title="Reference anomaly to the 30 full years nearest the record centre" aria-pressed="false">30 yr ref</button>
        </div>
        <div class="chart-trend-controls" role="group" aria-label="Trend and smoothing">
          <button class="chart-ci-btn active" data-action="trend-toggle" title="Show or hide the linear trend line" aria-pressed="true">Trend</button>
          <button class="chart-ci-btn" data-action="loess-toggle" title="Show or hide LOESS smooth line" aria-pressed="false">LOESS</button>
        </div>
        <div class="chart-zoom-controls" role="group" aria-label="Zoom controls">
          <button class="chart-zoom-btn" data-action="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
          <button class="chart-zoom-btn" data-action="zoom-reset" title="Reset zoom" aria-label="Reset zoom">⊙</button>
          <button class="chart-zoom-btn" data-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div class="chart-canvas-wrap"></div>
      <div class="chart-month-toggles" hidden role="group" aria-label="Month selection">
        ${_monthToggleButtons()}
      </div>
      <div class="chart-heat-legend" hidden aria-label="Temperature colour scale">
        <span class="heat-cold-label heat-label">—</span>
        <div class="heat-legend-bar" aria-hidden="true"></div>
        <span class="heat-hot-label heat-label">—</span>
      </div>
      <div class="chart-footer">
        <p class="chart-hint">Drag to pan · Hover for temperature</p>
        <div class="chart-loess-controls">
          <label class="loess-slider-label">
            <span class="loess-slider-title">Smoothing</span>
            <input type="range" class="loess-range" min="10" max="90" step="5" value="30" aria-label="LOESS span">
            <span class="loess-slider-value">0.30</span>
          </label>
        </div>
      </div>
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
      ${_buMapWrap(`<div class="detail-bu-map detail-map-media is-loading" data-sprite-src="assets/bu_2020_sprite.png" style="${_esc(style2020)}" aria-label="Built-up surface 2020 (20 km box)"></div>`)}
      ${scoreRow('2020')}
    </div>` : '';

  const panel1975 = has1975 ? `
    <div class="bu-tab-panel" data-panel="1975" hidden>
      ${_buMapWrap(`<div class="detail-bu-map detail-map-media is-loading" data-sprite-src="assets/bu_1975_sprite.png" style="${_esc(style1975)}" aria-label="Built-up surface 1975 (20 km box)"></div>`)}
      ${scoreRow('1975')}
    </div>` : '';

  const panelChange = hasChange ? `
    <div class="bu-tab-panel" data-panel="change" hidden>
      ${_buMapWrap(`<canvas class="detail-bu-change-canvas detail-map-media is-loading" data-renderer="bu-change" width="${display}" height="${display}" style="width:${display}px;height:${display}px" aria-label="Built-up surface change 1975–2020"></canvas>`)}
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
      ${_buMapWrap(`<div class="detail-bu-map detail-map-media is-loading" data-sprite-src="assets/pop_2020_sprite.png" style="${_esc(style2020)}" aria-label="Population density 2020 (20 km box)"></div>`)}
      ${scoreRightCol('2020')}
    </div>` : '';

  const panel1975 = has1975 ? `
    <div class="pop-tab-panel" data-panel="1975" hidden>
      ${_buMapWrap(`<div class="detail-bu-map detail-map-media is-loading" data-sprite-src="assets/pop_1975_sprite.png" style="${_esc(style1975)}" aria-label="Population density 1975 (20 km box)"></div>`)}
      ${scoreRightCol('1975')}
    </div>` : '';

  const popDisplay = (pop2020?.cell ?? pop1975?.cell ?? 32) * BU_ZOOM;
  const panelChange = hasChange ? `
    <div class="pop-tab-panel" data-panel="change" hidden>
      ${_buMapWrap(`<canvas class="detail-bu-change-canvas detail-map-media is-loading" data-renderer="pop-change" width="${popDisplay}" height="${popDisplay}" style="width:${popDisplay}px;height:${popDisplay}px" aria-label="Population density change 1975–2020"></canvas>`)}
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

function _setDetailMapLoading(el, isLoading) {
  if (!el) return;
  el.classList.toggle('is-loading', isLoading);
  el.closest('.detail-bu-wrap')?.classList.toggle('is-loading', isLoading);
}

function _initDetailMapMedia() {
  _panel?.querySelectorAll('.detail-map-media[data-sprite-src]').forEach(el => {
    const src = el.dataset.spriteSrc;
    if (!src) return;
    _setDetailMapLoading(el, true);
    _loadImg(src)
      .then(() => _setDetailMapLoading(el, false))
      .catch(() => _setDetailMapLoading(el, false));
  });

  _panel?.querySelectorAll('canvas.detail-map-media[data-renderer]').forEach(canvas => {
    if (!canvas.closest('[hidden]')) {
      const renderFn = canvas.dataset.renderer === 'pop-change'
        ? _renderPopChangeCanvas
        : _renderChangeCanvas;
      _renderDetailMapCanvas(canvas, renderFn);
    }
  });
}

function _renderDetailMapCanvas(canvas, renderFn) {
  if (!canvas || canvas._renderPromise) return canvas?._renderPromise;
  _setDetailMapLoading(canvas, true);
  canvas._renderPromise = Promise.resolve(renderFn(canvas))
    .catch(() => {})
    .finally(() => {
      _setDetailMapLoading(canvas, false);
    });
  return canvas._renderPromise;
}

async function _preparePrintMediaSnapshots() {
  if (!_panel) return;

  const spriteMaps = [..._panel.querySelectorAll('.detail-map-media[data-sprite-src]')];
  const changeCanvases = [..._panel.querySelectorAll('canvas.detail-map-media[data-renderer]')];

  await Promise.all([
    ...spriteMaps.map(el => _loadImg(el.dataset.spriteSrc).catch(() => null)),
    ...changeCanvases.map(canvas => {
      const renderFn = canvas.dataset.renderer === 'pop-change'
        ? _renderPopChangeCanvas
        : _renderChangeCanvas;
      return _renderDetailMapCanvas(canvas, renderFn);
    }),
  ]);

  for (const el of spriteMaps) {
    try {
      const dataUrl = await _rasterizeSpriteTile(el);
      _setPrintMediaSnapshot(el, dataUrl);
    } catch {}
  }

  for (const canvas of changeCanvases) {
    try {
      _setPrintMediaSnapshot(canvas, canvas.toDataURL('image/png'));
    } catch {}
  }
}

async function _rasterizeSpriteTile(el) {
  const src = el?.dataset?.spriteSrc;
  if (!src) return null;

  const img = await _loadImg(src);
  const cs = getComputedStyle(el);
  const width = parseFloat(cs.width);
  const height = parseFloat(cs.height);
  const [bgW, bgH] = cs.backgroundSize.split(' ').map(v => parseFloat(v));
  const [posX, posY] = cs.backgroundPosition.split(' ').map(v => parseFloat(v));
  if (!width || !height || !bgW || !bgH || !isFinite(posX) || !isFinite(posY)) return null;

  const scaleX = bgW / img.naturalWidth;
  const scaleY = bgH / img.naturalHeight;
  if (!scaleX || !scaleY) return null;

  const sx = -posX / scaleX;
  const sy = -posY / scaleY;
  const sw = width / scaleX;
  const sh = height / scaleY;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function _setPrintMediaSnapshot(sourceEl, dataUrl) {
  const wrap = sourceEl.closest('.detail-bu-wrap');
  if (!wrap || !dataUrl) return;
  let img = wrap.querySelector('.detail-print-media');
  if (!img) {
    img = document.createElement('img');
    img.className = 'detail-print-media';
    img.alt = sourceEl.getAttribute('aria-label') || '';
    wrap.insertBefore(img, wrap.firstChild);
  }
  img.src = dataUrl;
  img.style.width = sourceEl.style.width || `${sourceEl.clientWidth}px`;
  img.style.height = sourceEl.style.height || `${sourceEl.clientHeight}px`;
}

function _replaceChartCanvasWithSnapshot(canvas) {
  if (!canvas) return;
  let dataUrl = null;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch {
    return;
  }
  if (!dataUrl) return;
  const img = document.createElement('img');
  img.className = 'detail-chart-print-media';
  img.alt = '';
  img.src = dataUrl;
  img.style.width = canvas.style.width || `${canvas.clientWidth}px`;
  img.style.height = canvas.style.height || `${canvas.clientHeight}px`;
  canvas.replaceWith(img);
}

function _clearPrintMediaSnapshots() {
  _panel?.querySelectorAll('.detail-print-media').forEach(img => img.remove());
}

function _ensurePrintRoot() {
  if (_printRoot?.isConnected) return _printRoot;
  _printRoot = document.createElement('div');
  _printRoot.id = 'detail-print-root';
  _printRoot.className = 'detail-print-root';
  document.body.appendChild(_printRoot);
  return _printRoot;
}

async function _populatePrintRoot() {
  const root = _ensurePrintRoot();
  for (const chart of _printCharts) chart?.destroy();
  _printCharts = [];
  root.innerHTML = '';

  const clone = _panel.cloneNode(true);
  clone.classList.add('print-mode');
  clone.querySelectorAll('.section-panel[hidden]').forEach(p => p.removeAttribute('hidden'));
  clone.querySelector('.detail-name-toggle')?.setAttribute('aria-expanded', 'true');
  clone.querySelector('.detail-header-meta')?.removeAttribute('hidden');
  root.appendChild(clone);

  const stationUrl =
    `${window.location.origin}${window.location.pathname}#station=${encodeURIComponent(_currentLocationId)}`;
  clone.querySelectorAll('.qr-code').forEach(el => renderQR(stationUrl, el, 100));

  await new Promise(resolve => requestAnimationFrame(resolve));

  const qcuWrap = clone.querySelector('[data-section="temp-qcu"] .chart-canvas-wrap');
  const qcfWrap = clone.querySelector('[data-section="temp-qcf"] .chart-canvas-wrap');
  const adjWrap = clone.querySelector('[data-section="adj"] .chart-canvas-wrap');
  [qcuWrap, qcfWrap, adjWrap].forEach(wrap => { if (wrap) wrap.innerHTML = ''; });

  for (const section of ['temp-qcu', 'temp-qcf']) {
    const monthToggles = clone.querySelector(`[data-section="${section}"] .chart-month-toggles`);
    if (monthToggles) {
      if (_sharedChartMode === 'bymonth') monthToggles.removeAttribute('hidden');
      else monthToggles.setAttribute('hidden', '');
    }
  }

  const qcuChart = qcuWrap ? new TempChart(qcuWrap) : null;
  const qcfChart = qcfWrap ? new TempChart(qcfWrap) : null;
  const adjChart = adjWrap ? new AdjChart(adjWrap) : null;
  _printCharts = [qcuChart, qcfChart, adjChart].filter(Boolean);

  for (const chart of [qcuChart, qcfChart]) {
    if (!chart) continue;
    chart.setMode(_sharedChartMode);
    chart.setShowEst(_sharedShowEst);
    chart.setShowCI(_sharedShowCI);
    chart.setSelectedMonths(new Set(_sharedSelectedMonths));
    chart.setExcludeSparseAnomalyYears(_sharedExcludeSparseAnomalyYears);
    chart.setUseCenteredAnomalyReference(_sharedUseCenteredAnomalyReference);
    chart.setShowAnomalyTrend(_sharedShowAnomalyTrend);
    chart.setShowLoess(_sharedShowLoess);
    chart.setLoessSpan(_sharedLoessSpan);
  }
  if (adjChart) adjChart.setMode(_adjMode);

  if (qcuChart) qcuChart.load(_detailRawCsv.qcu || '');
  if (qcfChart) qcfChart.load(_detailRawCsv.qcf || '');

  const ranges = [qcuChart, qcfChart]
    .map(chart => chart?.getDataRange())
    .filter(Boolean);
  if (ranges.length > 0) {
    const globalMin = Math.min(...ranges.map(r => r.min));
    const globalMax = Math.max(...ranges.map(r => r.max));
    qcuChart?.setGlobalRange(globalMin, globalMax);
    qcfChart?.setGlobalRange(globalMin, globalMax);
    qcuChart?.resetZoom();
    qcfChart?.resetZoom();
    if (adjChart && _detailRawCsv.qcu != null && _detailRawCsv.qcf != null) {
      adjChart.load(_detailRawCsv.qcu, _detailRawCsv.qcf);
      adjChart.setGlobalRange(globalMin, globalMax);
      adjChart.resetZoom();
    }
  }

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (const chart of _printCharts) chart?.resize();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  clone.querySelectorAll('canvas.temp-chart-canvas').forEach(_replaceChartCanvasWithSnapshot);

  const brand = clone.querySelector('.detail-print-brand');
  const header = clone.querySelector('.detail-header');
  const sectionsByName = new Map(
    [...clone.querySelectorAll('.section-panel')].map(section => [section.dataset.section, section])
  );
  const pagesWrap = document.createElement('div');
  pagesWrap.className = 'detail-pdf-pages';
  const addPage = (sectionNames, { includeHeader = false } = {}) => {
    const page = document.createElement('section');
    page.className = 'detail-pdf-page';
    if (includeHeader) {
      if (brand) page.appendChild(brand);
      if (header) page.appendChild(header);
    }
    for (const name of sectionNames) {
      const section = sectionsByName.get(name);
      if (section) page.appendChild(section);
    }
    if (page.children.length > 0) {
      pagesWrap.appendChild(page);
    }
  };

  const addMapGridPage = (sectionNames) => {
    const sections = sectionNames
      .map(name => sectionsByName.get(name))
      .filter(Boolean);
    if (!sections.length) return;
    const page = document.createElement('section');
    page.className = 'detail-pdf-page';
    const grid = document.createElement('div');
    grid.className = 'detail-report-map-grid';
    sections.forEach(section => grid.appendChild(section));
    page.appendChild(grid);
    pagesWrap.appendChild(page);
  };

  const addCombinedAdjAndMapPage = () => {
    const adj = sectionsByName.get('adj');
    const mapSections = ['bu-surface', 'population']
      .map(name => sectionsByName.get(name))
      .filter(Boolean);
    if (!adj && !mapSections.length) return;
    const page = document.createElement('section');
    page.className = 'detail-pdf-page';
    if (adj) page.appendChild(adj);
    if (mapSections.length) {
      const grid = document.createElement('div');
      grid.className = 'detail-report-map-grid';
      mapSections.forEach(section => grid.appendChild(section));
      page.appendChild(grid);
    }
    pagesWrap.appendChild(page);
  };

  addPage(['temp-qcu', 'temp-qcf'], { includeHeader: true });
  addCombinedAdjAndMapPage();
  addPage(['about', 'sources-methods']);

  clone.innerHTML = '';
  clone.appendChild(pagesWrap);

  return root;
}

function _clearPrintRoot() {
  for (const chart of _printCharts) chart?.destroy();
  _printCharts = [];
  if (_printRoot) _printRoot.innerHTML = '';
}

async function _downloadPdfFromPrintRoot() {
  if (typeof html2canvas === 'undefined' || !window.jspdf?.jsPDF) {
    alert('PDF export library not loaded.');
    return;
  }

  const root = _printRoot;
  const pages = [...root.querySelectorAll('.detail-pdf-page')];
  if (!pages.length) throw new Error('No print pages were generated.');

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'in', format: 'letter' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 0.5;
  const footerReserve = 0.35;
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2 - footerReserve;
  const stationUrl = window.location.href;
  let firstOutputPage = true;

  for (const pageEl of pages) {
    const canvas = await html2canvas(pageEl, {
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      scale: 2,
      ignoreElements: el =>
        el.classList?.contains('detail-map-loading') ||
        el.classList?.contains('mapboxgl-canvas') ||
        el.classList?.contains('maplibregl-canvas'),
      onclone: (doc) => {
        doc.querySelectorAll(
          '#map, .map-wrapper, .mapboxgl-canvas, .mapboxgl-canvas-container, .mapboxgl-control-container, .detail-map-loading'
        ).forEach(el => el.remove());
        doc.querySelectorAll('.detail-bu-wrap').forEach(wrap => {
          const loader = wrap.querySelector('.detail-map-loading');
          if (loader) loader.remove();
        });
      },
    });

    const hasVisualPanel = !!pageEl.querySelector('.chart-canvas-wrap, .detail-bu-wrap');
    if (hasVisualPanel) {
      const imgAspect = canvas.height / canvas.width;
      let renderWidth = usableWidth;
      let renderHeight = renderWidth * imgAspect;
      if (renderHeight > usableHeight) {
        renderHeight = usableHeight;
        renderWidth = renderHeight / imgAspect;
      }
      const imgData = canvas.toDataURL('image/png');
      if (!firstOutputPage) pdf.addPage();
      firstOutputPage = false;
      pdf.addImage(imgData, 'PNG', margin + (usableWidth - renderWidth) / 2, margin, renderWidth, renderHeight, undefined, 'FAST');
      continue;
    }

    const sliceHeightPx = Math.floor(canvas.width * (usableHeight / usableWidth));
    let offsetY = 0;
    while (offsetY < canvas.height) {
      const h = Math.min(sliceHeightPx, canvas.height - offsetY);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = h;
      const ctx = slice.getContext('2d');
      ctx.drawImage(canvas, 0, offsetY, canvas.width, h, 0, 0, canvas.width, h);
      const imgData = slice.toDataURL('image/png');
      const imgHeight = (h / canvas.width) * usableWidth;

      if (!firstOutputPage) pdf.addPage();
      firstOutputPage = false;
      pdf.addImage(imgData, 'PNG', margin, margin, usableWidth, imgHeight, undefined, 'FAST');
      offsetY += h;
    }
  }

  const footerY = pageHeight - 0.22;
  const pageCount = pdf.getNumberOfPages();
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(90, 98, 109);
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.text(stationUrl, margin, footerY, { baseline: 'bottom' });
    pdf.text(`Page ${i}`, pageWidth - margin, footerY, { align: 'right', baseline: 'bottom' });
  }

  pdf.save(`meridian-${_currentLocationId}.pdf`);
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

/** Shared header HTML for both detail and index-only panels. */
function _detailHeader(category, name, data, indexEntry, locationId) {
  const shareSvg = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.17163025,6.5858 C5.56216,6.97632 5.56215,7.60948 5.17163025,8.00001 L3.75742,9.41422 C2.97637,10.1953 2.97637,11.4616 3.75742,12.2426 C4.53847,13.0237 5.8048,13.0237 6.58584,12.2426 L8.00006,10.8284 C8.39058,10.4379 9.02375,10.4379 9.41427,10.8284 C9.8048,11.219 9.8048,11.8521 9.41427,12.2426 L8.00006,13.6569 C6.43796,15.219 3.9053,15.219 2.3432,13.6569 C0.781107,12.0948 0.781107,9.56211 2.3432,8.00001 L3.75742,6.5858 C4.14794,6.19527 4.78111,6.19527 5.17163025,6.5858 Z M10.5355,5.4645 C10.926,5.85502 10.926,6.48819 10.5355,6.87871 L6.87863,10.5356 C6.4881,10.9261 5.85494,10.9261 5.46441,10.5356 C5.07389,10.145 5.07389,9.51188 5.46441,9.12135 L9.12127,5.4645 C9.51179,5.07397 10.145,5.07397 10.5355,5.4645 Z M13.6568,2.34314 C15.2189,3.90524 15.2189,6.4379 13.6568,8 L12.2426,9.41421 C11.8521,9.80473 11.2189,9.80473 10.8284,9.41421 C10.4379,9.02369 10.4379,8.39052 10.8284,8 L12.2426,6.58578 C13.0236,5.80473 13.0236,4.5384 12.2426,3.75736 C11.4615,2.97631 10.1952,2.97631 9.41416,3.75736 L7.99995,5.1715695 C7.60942,5.56209 6.97626,5.56209 6.58573,5.1715695 C6.19521,4.78105 6.19521,4.14788 6.58573,3.75736 L7.99995,2.34314 C9.56205,0.781046 12.0947,0.781046 13.6568,2.34314 Z"/></svg>`;
  const dlSvg    = `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M7.5 2v8M4.5 7.5l3 3 3-3M2 13h11"/></svg>`;
  const elevStr = data?.elevation
    ?? (indexEntry?.elevation_m != null ? `${indexEntry.elevation_m} m` : null);
  const latStr  = indexEntry?.lat  != null ? indexEntry.lat.toFixed(4)  : null;
  const lngStr  = indexEntry?.lng  != null ? indexEntry.lng.toFixed(4)  : null;
  const metaItems = [
    { label: 'Station ID', value: locationId },
    elevStr ? { label: 'Elevation', value: elevStr } : null,
    latStr ? { label: 'Latitude', value: latStr } : null,
    lngStr ? { label: 'Longitude', value: lngStr } : null,
  ].filter(Boolean);
  const metaHtml = metaItems.map(m => `
    <div class="meta-item">
      <span class="meta-label">${_esc(m.label)}</span>
      <span class="meta-value">${_esc(m.value)}</span>
    </div>`).join('');
  return `
    <div class="detail-print-brand">
      <span class="header-logo" aria-hidden="true">◎</span>
      <span class="header-title">Meridian</span>
      <span class="header-subtitle">Global Observatory Network</span>
    </div>
    <div class="detail-header">
      <div class="detail-header-left">
        ${category ? `<div class="detail-category">${_esc(category)}</div>` : ''}
        <button class="detail-name-toggle" type="button" aria-expanded="true" aria-controls="detail-header-meta">
          <h2 class="detail-name">${_esc(name)}</h2>
          <span class="detail-expand-chevron" aria-hidden="true">›</span>
        </button>
        ${metaHtml ? `<div class="detail-meta detail-header-meta" id="detail-header-meta">${metaHtml}</div>` : ''}
      </div>
      <div class="detail-header-qr">
        <div class="detail-qr detail-qr-header">
          <div class="qr-code"></div>
        </div>
      </div>
      <div class="detail-header-actions">
        <button class="detail-action-btn detail-share-btn" aria-label="Copy link to clipboard">${shareSvg}</button>
        <button class="detail-action-btn detail-download-btn" aria-label="Download report">${dlSvg}</button>
        <button class="detail-action-btn detail-close" aria-label="Close panel">×</button>
      </div>
      <div class="detail-header-tooltip" hidden></div>
    </div>`;
}

function _renderDetail(locationId, data, indexEntry, buSprites) {
  const category = data.type ?? indexEntry?.category ?? '';
  const name     = data.name ?? locationId;
  return `
    ${_detailHeader(category, name, data, indexEntry, locationId)}
    <div class="detail-download-menu" hidden role="menu">
      <button class="detail-download-opt" data-dl="png" role="menuitem">Image (PNG)</button>
      <button class="detail-download-opt" data-dl="pdf" role="menuitem">Report (PDF)</button>
    </div>
    ${_renderDataSections(data, indexEntry, locationId, buSprites)}`;
}

/**
 * Render a panel from index-only data (no detail JSON available).
 */
function _renderIndexDetail(locationId, indexEntry, buSprites) {
  const name     = indexEntry?.name ?? locationId;
  const category = indexEntry?.category ?? '';
  return `
    ${_detailHeader(category, name, null, indexEntry, locationId)}
    <div class="detail-download-menu" hidden role="menu">
      <button class="detail-download-opt" data-dl="png" role="menuitem">Image (PNG)</button>
      <button class="detail-download-opt" data-dl="pdf" role="menuitem">Report (PDF)</button>
    </div>
    ${_renderDataSections(null, indexEntry, locationId, buSprites)}`;
}

async function _downloadPng() {
  if (typeof html2canvas === 'undefined') { alert('Screenshot library not loaded.'); return; }
  // Resolve the panel's background from CSS custom properties so we always
  // get a fully-opaque colour regardless of backdrop-filter on the overlay.
  const panelBg = getComputedStyle(_panel).getPropertyValue('--bg-elevated').trim() || '#152c4a';
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
  const dlMenu = _panel.querySelector('.detail-download-menu');
  const exportHost = document.createElement('div');

  try {
    await _preparePrintMediaSnapshots();
    dlMenu && (dlMenu.hidden = true);
    _panel.classList.add('export-mode');
    await nextFrame();
    for (const chart of Object.values(_charts)) chart?.resize();
    await nextFrame();

    const exportPanel = _panel.cloneNode(true);
    exportHost.style.position = 'fixed';
    exportHost.style.left = '-20000px';
    exportHost.style.top = '0';
    exportHost.style.pointerEvents = 'none';
    exportHost.style.opacity = '0';
    exportHost.style.background = 'transparent';
    exportPanel.style.backgroundColor = panelBg;
    exportPanel.style.backdropFilter = 'none';
    exportHost.appendChild(exportPanel);
    document.body.appendChild(exportHost);

    // cloneNode() does not preserve canvas pixels, so copy them across after
    // the charts have been resized into the fixed export layout.
    const srcCanvases = _panel.querySelectorAll('canvas');
    const dstCanvases = exportPanel.querySelectorAll('canvas');
    srcCanvases.forEach((src, i) => {
      const dst = dstCanvases[i];
      if (!dst) return;
      dst.width = src.width;
      dst.height = src.height;
      dst.style.width = src.style.width;
      dst.style.height = src.style.height;
      const ctx = dst.getContext('2d');
      if (ctx) ctx.drawImage(src, 0, 0);
    });

    const canvas = await html2canvas(exportPanel, {
      useCORS: true,
      allowTaint: true,
      scale: Math.max(2, window.devicePixelRatio || 2),
      backgroundColor: panelBg,
      ignoreElements: el =>
        el.classList.contains('detail-download-menu') ||
        el.classList.contains('detail-map-loading') ||
        el.classList.contains('mapboxgl-canvas') ||
        el.classList.contains('maplibregl-canvas'),
      onclone: (doc) => {
        doc.querySelectorAll('.detail-map-loading, .mapboxgl-canvas, .maplibregl-canvas').forEach(el => el.remove());
      },
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    if (!blob) throw new Error('Canvas export returned no blob');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meridian-${_currentLocationId}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    console.error('PNG download failed:', e);
  } finally {
    exportHost.remove();
    _panel.classList.remove('export-mode');
    _clearPrintMediaSnapshots();
    await nextFrame();
    for (const chart of Object.values(_charts)) chart?.resize();
  }
}

function _printReport() {
  // 1. Reveal all hidden content sections and the print-only sources section.
  const hiddenPanels = [..._panel.querySelectorAll('.section-panel[hidden]:not(.print-only-panel)')];
  const printOnlyPanels = [..._panel.querySelectorAll('.print-only-panel[hidden]')];
  hiddenPanels.forEach(p => p.removeAttribute('hidden'));
  printOnlyPanels.forEach(p => p.removeAttribute('hidden'));

  // 2. Prepare printable media and build a dedicated print root outside the modal.
  requestAnimationFrame(async () => {
    await _preparePrintMediaSnapshots();
    await _populatePrintRoot();
    try {
      await _downloadPdfFromPrintRoot();
    } finally {
      hiddenPanels.forEach(p => p.setAttribute('hidden', ''));
      printOnlyPanels.forEach(p => p.setAttribute('hidden', ''));
      _clearPrintMediaSnapshots();
      _clearPrintRoot();
    }
  });
}

/** HTML-escape a value to prevent XSS when setting innerHTML. */
function _esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
