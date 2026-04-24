/**
 * Aggregate View — shows aggregate temperature charts for the current filtered
 * station set, fetched from the back-end aggregation API.
 *
 * Public API:
 *   initAggregateView()              — build DOM, wire events; call once after data is ready
 *   showAggregateView(stationIds)    — display the view and fetch data
 *   hideAggregateView()              — hide the view and destroy charts
 *   isAggregateVisible()             — boolean
 *   refreshAggregateView(stationIds) — re-fetch with a new ID list (filter changed)
 *   setFilterStateGetter(fn)         — register a fn() → activeSelections callback for URL state
 *   setUrlChangeCallback(fn)         — register a fn() called after every URL push (e.g. QR update)
 *   restoreGraphState(state)         — restore from a parsed URL graph state object
 *
 * API URL resolution:
 *   localhost / 127.0.0.1 → http://localhost:8081
 *   www.klymot.com        → https://api.klymot.com
 *   klymot.com            → https://api.klymot.com
 */

import { TempChart, MONTHS, MONTH_DASH, BYMONTH_DEFAULT_MASK } from './temp-chart.js?v=20260406';
import { pushState, serialiseGraphState } from './url-state.js?v=20260406';

// ── Module state ───────────────────────────────────────────────────────────────

let _container        = null;
let _getFilterSummary = null;
let _charts    = { qcu: null, qcf: null };
let _activeSeries         = 'qcu';
let _sharedMode           = 'yearly-anomaly';
let _sharedSelectedMonths = new Set([0, 6]);
let _sharedShowTrend      = true;
let _trendFromYear        = 0;     // 0 = all data, 1880, or 1950
let _sharedShowLoess      = false;
let _sharedLoessSpan      = 0.3;
let _sharedLoessSpanMode  = 'span'; // 'span' | 'years'
let _sharedLoessYears     = null;   // integer year value when mode='years'
let _geoGridded           = true;
let _fullYearsOnly        = true;
let _showCI               = true;
let _lastResponses        = { qcu: null, qcf: null };
let _visible              = false;
let _getFilterState       = null;  // () → activeSelections, set by app.js
let _onUrlChange          = null;  // () → void, called after every _pushUrl()
let _lastStationIds       = null;  // most recent station IDs passed to _loadData
let _loadGeneration       = 0;    // incremented on each _loadData call; stale responses are dropped

// Anomaly baseline state
let _anomalyMode          = 'station'; // station | auto_decade | auto_year | decade | year
let _anomalyFallback      = false;     // true → use *_fallback API variant for non-station modes
let _anomalyRef           = null;      // decade start (multiple of 10) or year; null for auto/station
let _refCoverageCache     = null;      // { decades: {decade→count}, years: {year→count}, maxCount }
let _refCoveragePending   = false;

// ── Mode helpers ───────────────────────────────────────────────────────────────

/** Returns true if the mode requires an anomaly fetch from the API. */
function _isAnomalyMode(mode) { return mode.endsWith('-anomaly'); }

/** Build the POST body for /api/v1/aggregate. */
function _buildAggregateBody(ids, series) {
  const body = { station_ids: ids, series, geo_gridded: _geoGridded, full_years_only: _fullYearsOnly };
  if (!_isAnomalyMode(_sharedMode)) {
    body.anomaly_mode = 'none';
  } else if (_anomalyMode === 'station') {
    body.anomaly_mode = 'station';
  } else {
    body.anomaly_mode = _anomalyFallback ? `${_anomalyMode}_fallback` : _anomalyMode;
    if (_anomalyMode === 'decade' || _anomalyMode === 'year') {
      body.anomaly_ref = _anomalyRef ?? 0;
    }
  }
  return body;
}

/** Fetch coverage data and cache it; lazily called before opening the picker. */
async function _fetchRefCoverage(ids, series) {
  if (_refCoveragePending) return;
  _refCoveragePending = true;
  try {
    const base   = _apiBase();
    const params = new URLSearchParams({ series });
    for (const id of ids) params.append('station_ids', id);
    const resp = await fetch(`${base}/api/v1/refcoverage?${params}`);
    if (!resp.ok) return;
    const raw = await resp.json(); // { decades: {year: count}, years: {year: count} }
    const allCounts = [...Object.values(raw.decades ?? {}), ...Object.values(raw.years ?? {})];
    _refCoverageCache = { decades: raw.decades ?? {}, years: raw.years ?? {}, maxCount: Math.max(1, ...allCounts) };
    // Rebuild picker if visible
    _container?.querySelectorAll('.chart-picker-row:not([hidden])').forEach(_buildPickerChips);
  } catch {
    // non-fatal — picker will fall back to synthetic range
  } finally {
    _refCoveragePending = false;
  }
}

/** Returns the TempChart mode string (strips '-anomaly' suffix). */
function _chartMode(mode) {
  if (mode === 'yearly-anomaly')  return 'yearly';
  if (mode === 'monthly-anomaly') return 'monthly';
  return mode;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the aggregate view DOM inside #aggregate-container and wire all events.
 * Must be called after the container element exists in the document.
 */
export function initAggregateView() {
  _container = document.getElementById('aggregate-container');
  if (!_container) return;
  _container.innerHTML = _buildHTML();
  _wireEvents();
}

export function isAggregateVisible() { return _visible; }

/** Register a callback that returns the current active filter selections for URL state. */
export function setFilterStateGetter(fn) { _getFilterState = fn; }

/** Register a callback that returns the current filter summary string for display. */
export function setFilterSummaryGetter(fn) { _getFilterSummary = fn; }

/** Register a callback invoked after every URL push (e.g. to update a QR code). */
export function setUrlChangeCallback(fn) { _onUrlChange = fn; }

/** Show the view and kick off a data fetch for the given station ID array. */
export function showAggregateView(stationIds) {
  if (!_container) return;
  _visible = true;
  _container.hidden = false;
  document.querySelector('.map-wrapper')?.classList.add('aggregate-active');
  _initCharts();
  _syncControlsToState();
  _loadData(stationIds);
  _pushUrl();
}

/** Hide the view and free chart resources. */
export function hideAggregateView() {
  if (!_container) return;
  _visible = false;
  _container.hidden = true;
  document.querySelector('.map-wrapper')?.classList.remove('aggregate-active');
  _destroyCharts();
}

/** Re-fetch with a new station ID list (called when the active filter changes). */
export function refreshAggregateView(stationIds) {
  if (!_visible) return;
  _loadData(stationIds);
  _pushUrl();
}

/**
 * Restore graph view from a parsed URL state object.
 * @param {object} state — as returned by parseHash for type==='graph'
 * @param {string[]} stationIds — current station IDs to fetch
 */
export function restoreGraphState(state, stationIds) {
  if (!_container) return;

  // Apply state before showing so initCharts picks up the right values.
  if (state.series === 'qcf') _activeSeries = 'qcf';
  if (state.mode)        _sharedMode       = state.mode;
  if (state.geoGridded)          _geoGridded       = true;
  if (state.fullYearsOnly === false) _fullYearsOnly = false;
  if (state.showCI === false)    _showCI           = false;
  if (state.showTrend === false) _sharedShowTrend = false;
  if (state.trendFromYear != null) _trendFromYear = state.trendFromYear;
  if (state.showLoess)   _sharedShowLoess  = true;
  if (state.loessSpan != null) _sharedLoessSpan = state.loessSpan;
  if (state.loessSpanMode) _sharedLoessSpanMode = state.loessSpanMode;
  if (state.loessYears != null) _sharedLoessYears = state.loessYears;
  if (Array.isArray(state.selectedMonths)) {
    _sharedSelectedMonths = new Set(state.selectedMonths);
  }
  if (state.anomalyMode)              _anomalyMode     = state.anomalyMode;
  if (state.anomalyFallback === true) _anomalyFallback = true;
  if (state.anomalyRef != null)       _anomalyRef      = state.anomalyRef;

  showAggregateView(stationIds);

  // Restore zoom after charts are created and data is loaded.
  if (state.zoomMin != null && state.zoomMax != null) {
    for (const c of Object.values(_charts)) {
      c?.setZoom(state.zoomMin, state.zoomMax);
    }
  }

  _syncControlsToState();
}

// ── API URL ────────────────────────────────────────────────────────────────────

function _apiBase() {
  const { hostname, protocol } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:8081';
  }
  // Strip leading "www." then prefix "api."
  return `${protocol}//api.${hostname.replace(/^www\./, '')}`;
}

/**
 * Returns true if the aggregate API server is reachable.
 * Uses a 3-second timeout so it never blocks startup for long.
 * Safe to call before initAggregateView().
 */
export async function checkApiAvailable() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`${_apiBase()}/api/v1/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

// ── URL state push ─────────────────────────────────────────────────────────────

function _pushUrl() {
  if (!_visible) return;
  const zoom = _charts[_activeSeries]?.getZoom();
  pushState(serialiseGraphState({
    series:        _activeSeries,
    mode:          _sharedMode,
    zoomMin:       zoom?.min,
    zoomMax:       zoom?.max,
    geoGridded:    _geoGridded,
    fullYearsOnly: _fullYearsOnly,
    showCI:        _showCI,
    showTrend:    _sharedShowTrend,
    trendFromYear: _trendFromYear,
    showLoess:     _sharedShowLoess,
    loessSpan:     _sharedLoessSpan,
    loessSpanMode: _sharedLoessSpanMode,
    loessYears:    _sharedLoessYears,
    selectedMonths:   _sharedSelectedMonths,
    anomalyMode:      _isAnomalyMode(_sharedMode) ? _anomalyMode : undefined,
    anomalyFallback:  _isAnomalyMode(_sharedMode) && _anomalyFallback ? true : undefined,
    anomalyRef:       _isAnomalyMode(_sharedMode) && _anomalyRef != null ? _anomalyRef : undefined,
  }, _getFilterState?.()));
  _onUrlChange?.();
}

// ── Data fetch ─────────────────────────────────────────────────────────────────

async function _loadData(stationIds) {
  const ids = stationIds ? [...stationIds] : [];
  const stationIdsChanged = JSON.stringify(ids) !== JSON.stringify(_lastStationIds);
  _lastStationIds = ids;
  const gen = ++_loadGeneration;
  if (stationIdsChanged) { _refCoverageCache = null; _refCoveragePending = false; }

  const _filterSummary = ids.length > 0 ? (_getFilterSummary?.() ?? '') : '';
  _setStatus(
    ids.length === 0
      ? 'No stations selected — apply a filter to see the aggregate.'
      : _filterSummary
        ? `${ids.length.toLocaleString()} station${ids.length !== 1 ? 's' : ''} · ${_filterSummary}`
        : `${ids.length.toLocaleString()} station${ids.length !== 1 ? 's' : ''}`
  );

  if (ids.length === 0) {
    _container?.classList.remove('is-loading');
    _lastResponses = { qcu: null, qcf: null };
    for (const c of Object.values(_charts)) c?.load('');
    return;
  }

  const base = _apiBase();

  // Clear stale data immediately so the chart area is blank while loading.
  for (const c of Object.values(_charts)) c?.load('');
  _container?.classList.add('is-loading');

  // Start both fetches immediately so they run concurrently with the rAF waits.
  // We must NOT start the fetch after the rAF — rAF fires before paint, so the
  // fetch microtasks would complete before the browser ever draws the spinner.
  const fetchPromise = Promise.all(['qcu', 'qcf'].map(async series => {
    try {
      const resp = await fetch(`${base}/api/v1/aggregate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_buildAggregateBody(ids, series)),
      });
      if (resp.status === 503) {
        const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '0', 10);
        return { series, data: null, overloaded: true, retryAfter };
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return { series, data: await resp.json() };
    } catch (err) {
      console.error(`aggregate ${series}:`, err);
      return { series, data: null };
    }
  }));

  // Two rAF yields guarantee the spinner is painted at least once.
  // rAF fires *before* paint; the browser paints between the two callbacks,
  // so by the time the second one resolves the spinner frame has been drawn.
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  if (gen !== _loadGeneration) return; // superseded by a newer call

  try {
    const results = await fetchPromise;

    if (gen !== _loadGeneration) return; // superseded while fetching

    // If the server rejected the request due to queue overload, show an error.
    const overloaded = results.find(r => r.overloaded);
    if (overloaded) {
      _setOverloadStatus(overloaded.retryAfter);
      return; // spinner cleared by finally
    }

    // Compute the union x-range across both series so the charts start and end at
    // the same point (mirrors the detail panel's cross-chart range synchronisation).
    let globalMin = Infinity, globalMax = -Infinity;
    const csvs = {};

    for (const { series, data } of results) {
      _lastResponses[series] = data;
      if (!data?.start || !data.counts?.length) { csvs[series] = ''; continue; }
      csvs[series] = _responseToCsv(data);
      const startYear = parseInt(data.start, 10);
      const endYear   = startYear + Math.floor((data.counts.length - 1) / 12);
      if (startYear < globalMin) globalMin = startYear;
      if (endYear   > globalMax) globalMax = endYear;
    }

    for (const series of ['qcu', 'qcf']) {
      const chart = _charts[series];
      if (!chart) continue;
      chart.load(csvs[series] ?? '');
      if (isFinite(globalMin)) chart.setGlobalRange(globalMin, globalMax + 1);
    }

    _recomputeYearsModeSpan();
    _updateLoessDisplay();
    _applyCI();
    _applyWeightedTrends();
  } finally {
    // Only the most recent call clears the spinner; stale calls leave it alone
    // so the in-progress newer call can manage its own state.
    if (gen === _loadGeneration) {
      _container?.classList.remove('is-loading');
    }
  }
}

/**
 * Convert an aggregate API response into the CSV text expected by TempChart.
 * Format: year,jan,feb,…,dec  (centidegrees; empty = missing)
 * The Go API always starts at January of the earliest year (start = "YYYY-01").
 */
function _responseToCsv(resp) {
  if (!resp?.start || !resp.counts?.length) return '';
  const startYear = parseInt(resp.start.split('-')[0], 10);
  const yearData  = {};
  for (let i = 0; i < resp.counts.length; i++) {
    const year = startYear + Math.floor(i / 12);
    const m    = i % 12;
    if (!yearData[year]) yearData[year] = new Array(12).fill('');
    if (resp.counts[i] > 0) yearData[year][m] = Math.round(resp.averages[i] * 100);
  }
  return Object.keys(yearData).map(Number).sort((a, b) => a - b)
    .map(y => `${y},${yearData[y].join(',')}`)
    .join('\n');
}

/**
 * Monthly CI bands: one band point per month slot.
 * SE = std_dev / sqrt(count) — uncertainty in the monthly station mean.
 */
function _computeMonthlyCIBands(resp) {
  if (!resp?.start || !resp.counts?.length || !resp.std_devs) return null;
  const startYear = parseInt(resp.start.split('-')[0], 10);
  const bands = [];

  for (let i = 0; i < resp.counts.length; i++) {
    const n = resp.counts[i];
    if (n < 2) {
      if (bands.length === 0 || bands[bands.length - 1] !== null) bands.push(null);
      continue;
    }
    const year  = startYear + Math.floor(i / 12);
    const month = i % 12;
    const x     = year + month / 12;
    const avg   = resp.averages[i];
    const se    = resp.std_devs[i] / Math.sqrt(n);
    bands.push({ x, low: avg - 1.96 * se, high: avg + 1.96 * se });
  }

  return bands;
}

/**
 * Annual CI bands: one band point per complete year (all 12 months present).
 *
 * The annual mean is the average of 12 monthly means.  Its uncertainty has
 * two independent components:
 *
 *   1. Station-sampling error — each monthly mean ȳᵢ has SE = σᵢ/√nᵢ; when
 *      we average k monthly means the combined variance is (1/k²)·Σ(σᵢ²/nᵢ).
 *
 *   2. Within-year month-to-month variability — the 12 monthly means spread
 *      around the annual mean; treating them as a sample of size k from the
 *      distribution of monthly temperatures adds a variance of s²/k, where
 *      s² is the sample variance of the k monthly means.
 *
 * Total SE = sqrt(station_var + month_var).
 *
 * Only complete years (all 12 months with count > 0) produce a band point,
 * matching TempChart's _yearlyPoints which also requires all 12 months.
 */
function _computeAnnualCIBands(resp) {
  if (!resp?.start || !resp.counts?.length || !resp.std_devs) return null;
  const startYear = parseInt(resp.start.split('-')[0], 10);
  const totalYears = Math.ceil(resp.counts.length / 12);
  const bands = [];

  for (let y = 0; y < totalYears; y++) {
    const baseIdx = y * 12;
    const year    = startYear + y;

    // Collect valid months for this year.
    const months = [];
    for (let m = 0; m < 12; m++) {
      const i = baseIdx + m;
      if (i >= resp.counts.length || resp.counts[i] < 1) break;
      months.push({ avg: resp.averages[i], sd: resp.std_devs[i], n: resp.counts[i] });
    }

    if (months.length < 12) {
      // Partial year — no yearly point in TempChart either.
      if (bands.length > 0 && bands[bands.length - 1] !== null) bands.push(null);
      continue;
    }

    const k           = 12;
    const annualMean  = months.reduce((s, m) => s + m.avg, 0) / k;

    // Component 1: station-sampling propagated through annual averaging.
    const stationVar  = months.reduce((s, m) => s + (m.sd * m.sd) / m.n, 0) / (k * k);

    // Component 2: month-to-month spread of the 12 monthly means.
    const sampleVar   = months.reduce((s, m) => s + (m.avg - annualMean) ** 2, 0) / (k - 1);
    const monthVar    = sampleVar / k;

    const se = Math.sqrt(stationVar + monthVar);
    bands.push({ x: year, low: annualMean - 1.96 * se, high: annualMean + 1.96 * se });
  }

  return bands;
}

/**
 * Per-month CI bands for bymonth mode.
 * Returns a 12-element array; each element is [{x: year, low, high}|null] for one month.
 * Nulls mark year gaps (matching how _byMonthPoints inserts gaps).
 */
function _computeByMonthCIBands(resp) {
  if (!resp?.start || !resp.counts?.length || !resp.std_devs) return null;
  const startYear  = parseInt(resp.start.split('-')[0], 10);
  const totalYears = Math.ceil(resp.counts.length / 12);
  const result     = Array.from({ length: 12 }, () => []);

  for (let m = 0; m < 12; m++) {
    let prevYear = null;
    for (let y = 0; y < totalYears; y++) {
      const i    = y * 12 + m;
      const year = startYear + y;
      if (i >= resp.counts.length || resp.counts[i] < 2) {
        if (result[m].length > 0 && result[m][result[m].length - 1] !== null) result[m].push(null);
        prevYear = null;
        continue;
      }
      if (prevYear !== null && year > prevYear + 1) result[m].push(null);
      const avg = resp.averages[i];
      const se  = resp.std_devs[i] / Math.sqrt(resp.counts[i]);
      result[m].push({ x: year, low: avg - 1.96 * se, high: avg + 1.96 * se });
      prevYear = year;
    }
  }
  return result;
}

// ── Weighted trend computation ─────────────────────────────────────────────────

/**
 * Lag-1 autocorrelation of a residual series (Yule-Walker estimate).
 * Returns a value in (−1, 1); clipped to ±0.99 to keep n_eff ≥ 1.
 * @param {number[]} res
 * @returns {number}
 */
function _lag1Autocorr(res) {
  const n = res.length;
  if (n < 3) return 0;
  let sum = 0;
  for (const r of res) sum += r;
  const mean = sum / n;
  let ss = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const c = res[i] - mean;
    ss += c * c;
    if (i < n - 1) cross += c * (res[i + 1] - mean);
  }
  if (ss < 1e-30) return 0;
  return Math.max(-0.99, Math.min(0.99, cross / ss));
}

/**
 * Inverse-variance weighted OLS trend with AR(1)-corrected standard error.
 * Each point carries a `w` weight field (w = 1/Var(mean_t)).
 * Under correctly-specified weights, Var(β̂₁) = Σw/denom; the ESS inflation
 * factor sqrt(n/n_eff) then accounts for residual autocorrelation.
 * @returns {{ slopePerYear, slopePer100Years, intercept, se }|null}
 *   se — AR(1)-corrected SE of slopePerYear (°C/yr); multiply by 100 for °C/100yr
 */
function _weightedTrendLine(pts) {
  if (pts.length < 2) return null;
  let sumW = 0, sumWX = 0, sumWY = 0, sumWXX = 0, sumWXY = 0;
  for (const p of pts) {
    sumW   += p.w;
    sumWX  += p.w * p.x;
    sumWY  += p.w * p.y;
    sumWXX += p.w * p.x * p.x;
    sumWXY += p.w * p.x * p.y;
  }
  const denom = sumW * sumWXX - sumWX * sumWX;
  if (Math.abs(denom) < 1e-12) return null;
  const slopePerYear = (sumW * sumWXY - sumWX * sumWY) / denom;
  const intercept    = (sumWY - slopePerYear * sumWX) / sumW;

  // AR(1)-corrected SE: theoretical IV-WLS SE inflated by sqrt(n/n_eff).
  const n         = pts.length;
  const residuals = pts.map(p => p.y - (intercept + slopePerYear * p.x));
  const seRaw     = Math.sqrt(sumW / denom);
  const rho       = _lag1Autocorr(residuals);
  const nEff      = Math.max(2, n * (1 - rho) / (1 + rho));
  const se        = seRaw * Math.sqrt(n / nEff);

  return { slopePerYear, slopePer100Years: slopePerYear * 100, intercept, se };
}

/** Convert trend-from slider index → year (0 = all data, 1–201 → 1800–2000). */
function _trendIdxToYear(idx) { return idx === 0 ? 0 : 1799 + idx; }
/** Convert year → slider index (0 = all data, 1800–2000 → 1–201; clamp out-of-range). */
function _trendYearToIdx(year) {
  if (!year) return 0;
  return Math.max(1, Math.min(201, year - 1799));
}

/**
 * Inverse-variance weight for a single monthly mean.
 * Var(mean) = σ²/n  ⟹  weight = n/σ².
 * Falls back to n when σ = 0 (only one station, or all stations agree exactly).
 */
function _ivWeight(n, sd) {
  return (n >= 2 && sd > 0) ? n / (sd * sd) : n;
}

/**
 * Weighted trend for monthly mode.
 * Weight = n/σ² (inverse variance of the multi-station mean).
 * @param {object} resp
 * @param {number} [fromYear] — exclude points before this year (0 = all data)
 */
function _computeWeightedMonthlyTrend(resp, fromYear = 0) {
  if (!resp?.start || !resp.counts?.length) return null;
  const startYear = parseInt(resp.start.split('-')[0], 10);
  const pts = [];
  for (let i = 0; i < resp.counts.length; i++) {
    const n = resp.counts[i];
    if (n < 1) continue;
    const x = startYear + Math.floor(i / 12) + (i % 12) / 12;
    if (fromYear > 0 && x < fromYear) continue;
    pts.push({ x, y: resp.averages[i], w: _ivWeight(n, resp.std_devs?.[i] ?? 0) });
  }
  return _weightedTrendLine(pts);
}

/**
 * Weighted trend for yearly mode: only complete years (all 12 months present).
 * Weight = 1 / annualVariance, where annualVariance combines the two components
 * used for the annual CI bands (station-sampling + month-to-month spread).
 * Falls back to total station-months when variance is zero.
 * @param {object} resp
 * @param {number} [fromYear] — exclude years before this (0 = all data)
 */
function _computeWeightedAnnualTrend(resp, fromYear = 0) {
  if (!resp?.start || !resp.counts?.length) return null;
  const startYear  = parseInt(resp.start.split('-')[0], 10);
  const totalYears = Math.ceil(resp.counts.length / 12);
  const pts = [];
  for (let y = 0; y < totalYears; y++) {
    if (fromYear > 0 && startYear + y < fromYear) continue;
    let valid = true;
    const months = [];
    for (let m = 0; m < 12; m++) {
      const i = y * 12 + m;
      if (i >= resp.counts.length || resp.counts[i] < 1) { valid = false; break; }
      months.push({ avg: resp.averages[i], sd: resp.std_devs?.[i] ?? 0, n: resp.counts[i] });
    }
    if (!valid) continue;
    const k          = 12;
    const annualMean = months.reduce((s, m) => s + m.avg, 0) / k;
    // Component 1: station-sampling propagated through annual averaging.
    const stationVar = months.reduce((s, m) => s + (m.sd * m.sd) / Math.max(m.n, 1), 0) / (k * k);
    // Component 2: month-to-month spread of the 12 monthly means.
    const sampleVar  = months.reduce((s, m) => s + (m.avg - annualMean) ** 2, 0) / (k - 1);
    const monthVar   = sampleVar / k;
    const annualVar  = stationVar + monthVar;
    // Inverse-variance weight; fall back to station-months when variance is zero.
    const totalN = months.reduce((s, m) => s + m.n, 0);
    pts.push({ x: startYear + y, y: annualMean, w: annualVar > 0 ? 1 / annualVar : totalN });
  }
  return _weightedTrendLine(pts);
}

/**
 * Weighted trends for bymonth mode: one trend per calendar month.
 * Weight = n/σ² (inverse variance of the multi-station mean).
 * Returns a 12-element array; null entries mean insufficient data.
 * @param {object} resp
 * @param {number} [fromYear] — exclude years before this (0 = all data)
 */
function _computeWeightedByMonthTrends(resp, fromYear = 0) {
  if (!resp?.start || !resp.counts?.length) return null;
  const startYear  = parseInt(resp.start.split('-')[0], 10);
  const totalYears = Math.ceil(resp.counts.length / 12);
  return Array.from({ length: 12 }, (_, m) => {
    const pts = [];
    for (let y = 0; y < totalYears; y++) {
      if (fromYear > 0 && startYear + y < fromYear) continue;
      const i = y * 12 + m;
      if (i >= resp.counts.length || resp.counts[i] < 1) continue;
      const n = resp.counts[i];
      pts.push({ x: startYear + y, y: resp.averages[i], w: _ivWeight(n, resp.std_devs?.[i] ?? 0) });
    }
    return _weightedTrendLine(pts);
  });
}

/** Show the | separator only when both sliders are visible. */
function _syncSliderSep() {
  const vis = _sharedShowTrend && _sharedShowLoess ? 'visible' : 'hidden';
  _container?.querySelectorAll('.chart-slider-sep').forEach(s => { s.style.visibility = vis; });
}

/** Push weighted trends onto both charts for the current mode. */
function _applyWeightedTrends() {
  for (const series of ['qcu', 'qcf']) {
    const chart = _charts[series];
    const resp  = _lastResponses[series];
    if (!chart) continue;
    if (!resp) {
      chart.setExternalTrend(null);
      chart.setExternalTrendsByMonth(null);
      continue;
    }
    const cm = _chartMode(_sharedMode);
    if (cm === 'yearly') {
      chart.setExternalTrend(_computeWeightedAnnualTrend(resp, _trendFromYear));
      chart.setExternalTrendsByMonth(null);
    } else if (cm === 'bymonth') {
      chart.setExternalTrend(null);
      chart.setExternalTrendsByMonth(_computeWeightedByMonthTrends(resp, _trendFromYear));
    } else {
      chart.setExternalTrend(_computeWeightedMonthlyTrend(resp, _trendFromYear));
      chart.setExternalTrendsByMonth(null);
    }
  }
}

/**
 * Apply or clear CI bands on all charts based on _showCI, _lastResponses, and
 * the current mode.  Each mode gets the appropriate band type:
 *   monthly  → flat monthly bands (one point per month slot)
 *   yearly   → annual bands combining station + within-year variance
 *   bymonth  → per-month band arrays, one per calendar month
 */
function _applyCI() {
  for (const series of ['qcu', 'qcf']) {
    const chart = _charts[series];
    if (!chart) continue;
    if (_showCI && _lastResponses[series]) {
      const resp = _lastResponses[series];
      const cm = _chartMode(_sharedMode);
      if (cm === 'yearly') {
        chart.setExternalBands(_computeAnnualCIBands(resp));
        chart.setExternalBandsByMonth(null);
      } else if (cm === 'bymonth') {
        chart.setExternalBands(null);
        chart.setExternalBandsByMonth(_computeByMonthCIBands(resp));
      } else {
        chart.setExternalBands(_computeMonthlyCIBands(resp));
        chart.setExternalBandsByMonth(null);
      }
    } else {
      chart.setExternalBands(null);
      chart.setExternalBandsByMonth(null);
    }
    chart.setShowExternalBands(_showCI);
  }
}

// ── Status display ─────────────────────────────────────────────────────────────

function _setStatus(text) {
  const el = _container?.querySelector('.aggregate-status');
  if (!el) return;
  el.classList.remove('is-error');
  el.textContent = text;
}

function _setOverloadStatus(retryAfterSecs) {
  const el = _container?.querySelector('.aggregate-status');
  if (!el) return;
  el.classList.add('is-error');
  const hint = retryAfterSecs > 0 ? ` Try again in ~${Math.ceil(retryAfterSecs)}s.` : '';
  el.textContent = `Server is busy — too many requests queued.${hint} Try again later.`;
}

// ── Chart lifecycle ────────────────────────────────────────────────────────────

function _initCharts() {
  _destroyCharts();
  for (const series of ['qcu', 'qcf']) {
    const wrap = _container.querySelector(`.section-panel[data-agg-series="${series}"] .chart-canvas-wrap`);
    if (!wrap) continue;
    const chart = new TempChart(wrap);
    _charts[series] = chart;
    chart.setMode(_chartMode(_sharedMode));
    chart.setSelectedMonths(new Set(_sharedSelectedMonths));
    chart.setShowLoess(_sharedShowLoess);
    chart.setLoessSpan(_sharedLoessSpan);
    chart.setShowAnomalyTrend(_sharedShowTrend);
    chart.setShowExternalBands(_showCI);

    // Push URL on zoom change.
    wrap.addEventListener('chart:zoom', () => _pushUrl());
  }
  _applySharedMode(); // sync button states to current _sharedMode
}

function _destroyCharts() {
  for (const c of Object.values(_charts)) c?.destroy();
  _charts = { qcu: null, qcf: null };
}

// ── Series tab switching ───────────────────────────────────────────────────────

function _switchSeries(series) {
  if (series === _activeSeries) return;
  _activeSeries = series;

  _container.querySelectorAll('button[data-agg-series]').forEach(btn => {
    const active = btn.dataset.aggSeries === series;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  _container.querySelectorAll('.section-panel[data-agg-series]').forEach(panel => {
    panel.hidden = panel.dataset.aggSeries !== series;
  });

  // Resize the newly-visible chart (was display:none → size was 0).
  _charts[series]?.resize();

  // Sync zoom from the other series so pan/zoom is preserved on tab switch.
  const other = series === 'qcu' ? 'qcf' : 'qcu';
  const otherZoom = _charts[other]?.getZoom();
  if (otherZoom) _charts[series]?.setZoom(otherZoom.min, otherZoom.max);

  _pushUrl();
}

// ── Chart mode switching ───────────────────────────────────────────────────────

function _applySharedMode() {
  const mode = _sharedMode;
  for (const series of ['qcu', 'qcf']) {
    const panel = _container?.querySelector(`.section-panel[data-agg-series="${series}"]`);
    if (!panel) continue;

    panel.querySelectorAll('.chart-mode-btn').forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const monthToggles = panel.querySelector('.chart-month-toggles');
    if (monthToggles) monthToggles.hidden = mode !== 'bymonth';

    const hint = panel.querySelector('.chart-hint');
    if (hint) {
      hint.style.visibility = mode === 'bymonth' ? 'hidden' : 'visible';
      if (mode !== 'bymonth') hint.textContent = 'Drag to pan · Hover for temperature';
    }

    panel.querySelector('.chart-mode-row')?._updateArrows?.();
    _charts[series]?.setMode(_chartMode(mode));
  }
  // Swap CI bands and weighted trends for the new mode.
  _applyCI();
  _applyWeightedTrends();
  _applyRefRows();
}

/** Sync ref row and picker row UI to _anomalyMode / _anomalyRef / _anomalyFallback. */
function _applyRefRows() {
  const isAnomaly = _isAnomalyMode(_sharedMode);
  const showPicker = isAnomaly && (_anomalyMode === 'decade' || _anomalyMode === 'year');

  _container?.querySelectorAll('.chart-ref-row').forEach(refRow => {
    refRow.hidden = !isAnomaly;
    if (!isAnomaly) return;

    refRow.querySelectorAll('.chart-ref-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.ref === _anomalyMode);
    });

    const pickerRow = refRow.closest('.chart-footer').querySelector('.chart-picker-row');
    if (!pickerRow) return;
    pickerRow.hidden = !showPicker;
    if (showPicker) _buildPickerChips(pickerRow);
  });
}

function _buildPickerChips(pickerRow) {
  const track = pickerRow.querySelector('.picker-track');
  if (!track) return;

  const isDecade = _anomalyMode === 'decade';
  const cov  = _refCoverageCache;
  const data = cov ? (isDecade ? cov.decades : cov.years) : {};
  const maxC = cov?.maxCount || 1;

  let keys;
  if (cov) {
    keys = Object.keys(data).map(Number).sort((a, b) => a - b);
  } else if (isDecade) {
    keys = [];
    for (let d = 1850; d <= 2020; d += 10) keys.push(d);
  } else {
    keys = [];
    for (let y = 1850; y <= new Date().getFullYear(); y++) keys.push(y);
  }

  const frag = document.createDocumentFragment();
  for (const k of keys) {
    const count  = data[k] ?? 0;
    const cov01  = maxC > 0 ? count / maxC : 0;
    const active = k === _anomalyRef;
    const noData = count === 0 && cov != null;
    const btn    = document.createElement('button');
    btn.className = 'picker-chip' + (active ? ' active' : '') + (noData ? ' no-data' : '');
    btn.dataset.val = String(k);
    btn.style.setProperty('--cov', cov01.toFixed(3));
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = isDecade ? `${k}s` : String(k);
    if (noData) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
    btn.addEventListener('click', () => {
      _anomalyRef = k;
      _applyRefRows();
      if (_lastStationIds !== null) _loadData(_lastStationIds);
      _pushUrl();
    });
    frag.appendChild(btn);
  }
  track.replaceChildren(frag);

  requestAnimationFrame(() => {
    pickerRow.querySelector('.picker-chip.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  });
}

function _pickerStep(dir) {
  const isDecade = _anomalyMode === 'decade';
  const data = _refCoverageCache ? (isDecade ? _refCoverageCache.decades : _refCoverageCache.years) : {};
  const keys = Object.keys(data).map(Number).filter(k => (data[k] ?? 0) > 0).sort((a, b) => a - b);
  if (keys.length === 0) return;
  const cur = _anomalyRef ?? keys[0];
  const i   = keys.indexOf(cur);
  const ni  = Math.max(0, Math.min(keys.length - 1, (i === -1 ? 0 : i) + dir));
  if (keys[ni] !== cur) {
    _anomalyRef = keys[ni];
    _applyRefRows();
    if (_lastStationIds !== null) _loadData(_lastStationIds);
    _pushUrl();
  }
}

function _firstAvailableDecade() {
  if (!_refCoverageCache) return 1950;
  const keys = Object.keys(_refCoverageCache.decades).map(Number)
    .filter(k => _refCoverageCache.decades[k] > 0).sort((a, b) => a - b);
  return keys[Math.floor(keys.length / 2)] ?? 1950;
}

function _firstAvailableYear() {
  if (!_refCoverageCache) return 1961;
  const keys = Object.keys(_refCoverageCache.years).map(Number)
    .filter(k => _refCoverageCache.years[k] > 0).sort((a, b) => a - b);
  return keys[Math.floor(keys.length / 2)] ?? 1961;
}

/** Sync all toggle button visual states to module state (used after restoreGraphState). */
function _syncControlsToState() {
  // Series tabs
  _container?.querySelectorAll('button[data-agg-series]').forEach(btn => {
    const active = btn.dataset.aggSeries === _activeSeries;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  _container?.querySelectorAll('.section-panel[data-agg-series]').forEach(panel => {
    panel.hidden = panel.dataset.aggSeries !== _activeSeries;
  });

  // Trend toggle + from-year slider
  _container?.querySelectorAll('[data-action="trend-toggle"]').forEach(b => {
    b.classList.toggle('active', _sharedShowTrend);
    b.setAttribute('aria-pressed', String(_sharedShowTrend));
  });
  _container?.querySelectorAll('.chart-trend-from-controls').forEach(c => {
    c.style.visibility = _sharedShowTrend ? 'visible' : 'hidden';
  });
  _container?.querySelectorAll('.trend-from-range').forEach(s => { s.value = _trendYearToIdx(_trendFromYear); });
  _container?.querySelectorAll('.trend-from-value').forEach(v => {
    v.textContent = _trendFromYear > 0 ? String(_trendFromYear) : 'All';
  });

  // LOESS toggle
  _container?.querySelectorAll('[data-action="loess-toggle"]').forEach(b => {
    b.classList.toggle('active', _sharedShowLoess);
    b.setAttribute('aria-pressed', String(_sharedShowLoess));
  });
  _container?.querySelectorAll('.chart-loess-controls').forEach(c => {
    c.style.visibility = _sharedShowLoess ? 'visible' : 'hidden';
  });

  // Geo-gridded toggle
  _container?.querySelectorAll('[data-action="geo-toggle"]').forEach(b => {
    b.classList.toggle('active', _geoGridded);
    b.setAttribute('aria-pressed', String(_geoGridded));
  });

  // Full-years-only toggle
  _container?.querySelectorAll('[data-action="fy-toggle"]').forEach(b => {
    b.classList.toggle('active', _fullYearsOnly);
    b.setAttribute('aria-pressed', String(_fullYearsOnly));
  });

  // CI toggle
  _container?.querySelectorAll('[data-action="ci-toggle"]').forEach(b => {
    b.classList.toggle('active', _showCI);
    b.setAttribute('aria-pressed', String(_showCI));
  });

  // LOESS span slider + mode buttons
  _applyLoessMode();
  _updateLoessDisplay();

  _syncSliderSep();
  _applySharedMode();
}

// ── LOESS helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a target SMA-equivalent year count to a LOESS span.
 * No clamping — year mode allows span outside the span-mode slider range.
 */
function _yearsToSpan(years, n) {
  const k = Math.max(3, Math.round(years * 1.40));
  return k / n;
}

/**
 * When in year-equivalent mode and chart data is freshly loaded, recompute
 * _sharedLoessSpan from _sharedLoessYears and push it to all charts.
 * No-op when in span mode or when no data is loaded yet.
 */
function _recomputeYearsModeSpan() {
  if (_sharedLoessSpanMode !== 'years' || _sharedLoessYears == null) return;
  let n = null;
  for (const c of Object.values(_charts)) {
    const cnt = c?.getYearlyCount?.();
    if (cnt != null) { n = cnt; break; }
  }
  if (n == null) return;
  const newSpan = _yearsToSpan(_sharedLoessYears, n);
  if (Math.abs(newSpan - _sharedLoessSpan) > 0.001) {
    _sharedLoessSpan = newSpan;
    for (const c of Object.values(_charts)) c?.setLoessSpan(_sharedLoessSpan);
  }
}

/**
 * Sync the slider min/max/value and mode-button active states to the current
 * _sharedLoessSpanMode.  Called when the mode changes or state is restored.
 */
function _applyLoessMode() {
  const isYears = _sharedLoessSpanMode === 'years';
  _container?.querySelectorAll('.loess-range').forEach(s => {
    s.min   = isYears ? '2'  : '1';
    s.max   = isYears ? '60' : '99';
    s.step  = '1';
    s.value = isYears
      ? String(_sharedLoessYears ?? 10)
      : String(Math.round(_sharedLoessSpan * 100));
  });
  _container?.querySelectorAll('.loess-mode-btn').forEach(b => {
    const active = b.dataset.loessMode === _sharedLoessSpanMode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

/**
 * Update the span-button and years-button text to reflect the current values.
 * Falls back to '— yr' for the years button when no chart data is loaded yet.
 */
function _updateLoessDisplay() {
  let yrs = null;
  for (const c of Object.values(_charts)) {
    const v = c?.getLoessEffectiveYears?.();
    if (v != null) { yrs = v; break; }
  }
  _container?.querySelectorAll('.loess-span-btn').forEach(el => {
    el.textContent = _sharedLoessSpan.toFixed(2);
  });
  _container?.querySelectorAll('.loess-years-btn').forEach(el => {
    el.textContent = yrs != null ? `${yrs} yr` : '— yr';
  });
}

// ── Event wiring ───────────────────────────────────────────────────────────────

function _wireEvents() {
  // Series tabs
  _container.querySelectorAll('button[data-agg-series]').forEach(btn => {
    btn.addEventListener('click', () => _switchSeries(btn.dataset.aggSeries));
  });

  // Mode buttons — click on either panel's buttons syncs both.
  _container.querySelectorAll('.chart-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prevAnomaly = _isAnomalyMode(_sharedMode);
      _sharedMode = btn.dataset.mode;
      _applySharedMode();
      _pushUrl();
      // Refetch if anomaly status changed (different API response needed).
      if (_isAnomalyMode(_sharedMode) !== prevAnomaly && _lastStationIds !== null) {
        _loadData(_lastStationIds);
      }
    });
  });

  // Zoom buttons — operate on the currently active series' chart.
  _container.querySelectorAll('.chart-zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const chart = _charts[_activeSeries];
      if (btn.dataset.action === 'zoom-in')    chart?.zoomIn();
      if (btn.dataset.action === 'zoom-out')   chart?.zoomOut();
      if (btn.dataset.action === 'zoom-reset') chart?.resetZoom();
    });
  });

  // Month toggles — toggling one syncs the matching button in the other panel.
  _container.querySelectorAll('.month-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = parseInt(btn.dataset.month, 10);
      const nowActive = btn.classList.toggle('active');
      btn.setAttribute('aria-pressed', String(nowActive));
      _container.querySelectorAll(`.month-toggle-btn[data-month="${m}"]`).forEach(b => {
        if (b !== btn) {
          b.classList.toggle('active', nowActive);
          b.setAttribute('aria-pressed', String(nowActive));
        }
      });
      if (nowActive) _sharedSelectedMonths.add(m);
      else           _sharedSelectedMonths.delete(m);
      for (const c of Object.values(_charts)) c?.setSelectedMonths(new Set(_sharedSelectedMonths));
      _pushUrl();
    });
  });

  // Trend toggle
  _container.querySelectorAll('[data-action="trend-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _sharedShowTrend = !_sharedShowTrend;
      _container.querySelectorAll('[data-action="trend-toggle"]').forEach(b => {
        b.classList.toggle('active', _sharedShowTrend);
        b.setAttribute('aria-pressed', String(_sharedShowTrend));
      });
      _container.querySelectorAll('.chart-trend-from-controls').forEach(c => {
        c.style.visibility = _sharedShowTrend ? 'visible' : 'hidden';
      });
      _syncSliderSep();
      for (const c of Object.values(_charts)) c?.setShowAnomalyTrend(_sharedShowTrend);
      _pushUrl();
    });
  });

  // Trend from-year slider
  _container.querySelectorAll('.trend-from-range').forEach(slider => {
    slider.addEventListener('input', () => {
      const idx = parseInt(slider.value, 10);
      _trendFromYear = _trendIdxToYear(idx);
      _container.querySelectorAll('.trend-from-range').forEach(s => { s.value = idx; });
      _container.querySelectorAll('.trend-from-value').forEach(v => {
        v.textContent = _trendFromYear > 0 ? String(_trendFromYear) : 'All';
      });
      _applyWeightedTrends();
      _pushUrl();
    });
  });

  // LOESS toggle
  _container.querySelectorAll('[data-action="loess-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _sharedShowLoess = !_sharedShowLoess;
      _container.querySelectorAll('[data-action="loess-toggle"]').forEach(b => {
        b.classList.toggle('active', _sharedShowLoess);
        b.setAttribute('aria-pressed', String(_sharedShowLoess));
      });
      _container.querySelectorAll('.chart-loess-controls').forEach(c => {
        c.style.visibility = _sharedShowLoess ? 'visible' : 'hidden';
      });
      _syncSliderSep();
      for (const c of Object.values(_charts)) c?.setShowLoess(_sharedShowLoess);
      if (_sharedShowLoess) _updateLoessDisplay();
      _pushUrl();
    });
  });

  // Geo-gridded toggle
  _container.querySelectorAll('[data-action="geo-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _geoGridded = !_geoGridded;
      _container.querySelectorAll('[data-action="geo-toggle"]').forEach(b => {
        b.classList.toggle('active', _geoGridded);
        b.setAttribute('aria-pressed', String(_geoGridded));
      });
      // Re-fetch with new geo_gridded setting.
      if (_lastStationIds !== null) _loadData(_lastStationIds);
      _pushUrl();
    });
  });

  // Full-years-only toggle
  _container.querySelectorAll('[data-action="fy-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _fullYearsOnly = !_fullYearsOnly;
      _container.querySelectorAll('[data-action="fy-toggle"]').forEach(b => {
        b.classList.toggle('active', _fullYearsOnly);
        b.setAttribute('aria-pressed', String(_fullYearsOnly));
      });
      if (_lastStationIds !== null) _loadData(_lastStationIds);
      _pushUrl();
    });
  });

  // CI toggle
  _container.querySelectorAll('[data-action="ci-toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      _showCI = !_showCI;
      _container.querySelectorAll('[data-action="ci-toggle"]').forEach(b => {
        b.classList.toggle('active', _showCI);
        b.setAttribute('aria-pressed', String(_showCI));
      });
      _applyCI();
      _pushUrl();
    });
  });

  // LOESS mode buttons (span / years equivalent).
  _container.querySelectorAll('.loess-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.loessMode;
      if (newMode === _sharedLoessSpanMode) return;
      if (newMode === 'years') {
        // Derive current year equivalent, clamped to the year slider range.
        let yrs = null;
        for (const c of Object.values(_charts)) {
          const v = c?.getLoessEffectiveYears?.();
          if (v != null) { yrs = v; break; }
        }
        _sharedLoessYears = yrs != null ? Math.max(2, Math.min(60, yrs)) : 10;
      } else {
        // Clamp span to the span-slider range when entering span mode.
        _sharedLoessSpan = Math.max(0.01, Math.min(0.99, _sharedLoessSpan));
        for (const c of Object.values(_charts)) c?.setLoessSpan(_sharedLoessSpan);
        _sharedLoessYears = null;
      }
      _sharedLoessSpanMode = newMode;
      _applyLoessMode();
      _updateLoessDisplay();
      _pushUrl();
    });
  });

  // LOESS span slider — sync both panels' sliders.
  _container.querySelectorAll('.loess-range').forEach(slider => {
    slider.addEventListener('input', () => {
      if (_sharedLoessSpanMode === 'years') {
        _sharedLoessYears = parseInt(slider.value, 10);
        // Compute span from years using loaded data count.
        let n = null;
        for (const c of Object.values(_charts)) {
          const cnt = c?.getYearlyCount?.();
          if (cnt != null) { n = cnt; break; }
        }
        _sharedLoessSpan = n != null
          ? _yearsToSpan(_sharedLoessYears, n)
          : _sharedLoessYears * 1.40 / 100; // rough estimate until data loads
      } else {
        _sharedLoessSpan = slider.value / 100;
      }
      _container.querySelectorAll('.loess-range').forEach(s => { s.value = slider.value; });
      for (const c of Object.values(_charts)) c?.setLoessSpan(_sharedLoessSpan);
      _updateLoessDisplay();
      _pushUrl();
    });
  });

  _initModeArrows();
  _initRefRows();
}

// ── Generic scroll-row helper ──────────────────────────────────────────────────
// Manages ‹/› visibility, right-edge fade, and smooth scroll for any
// overflow-x row wrapped in .scroll-fade-wrap.
function _initScrollRow({ scrollEl, wrapEl, prevBtn, nextBtn, scrollPx = 110 }) {
  function update() {
    const canLeft  = scrollEl.scrollLeft > 2;
    const canRight = scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 2;
    if (prevBtn) prevBtn.hidden = !canLeft;
    if (nextBtn) nextBtn.hidden = !canRight;
    if (wrapEl)  wrapEl.classList.toggle('can-scroll-right', canRight);
  }
  if (prevBtn) prevBtn.addEventListener('click', () => scrollEl.scrollBy({ left: -scrollPx, behavior: 'smooth' }));
  if (nextBtn) nextBtn.addEventListener('click', () => scrollEl.scrollBy({ left:  scrollPx, behavior: 'smooth' }));
  scrollEl.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scrollEl);
  requestAnimationFrame(update);
  return update;
}

function _initModeArrows() {
  _container.querySelectorAll('.chart-mode-row').forEach(modeRow => {
    const toggle  = modeRow.querySelector('.chart-mode-toggle');
    const prevBtn = modeRow.querySelector('.chart-mode-prev');
    const nextBtn = modeRow.querySelector('.chart-mode-next');
    if (!toggle || !prevBtn || !nextBtn) return;

    const getBtns      = () => [...toggle.querySelectorAll('.chart-mode-btn:not([hidden])')];
    const getActiveIdx = () => getBtns().findIndex(b => b.classList.contains('active'));

    function updateArrows() {
      const idx   = getActiveIdx();
      const total = getBtns().length;
      prevBtn.hidden = idx <= 0;
      nextBtn.hidden = idx >= total - 1;
    }

    prevBtn.addEventListener('click', () => {
      const idx = getActiveIdx();
      if (idx > 0) getBtns()[idx - 1].click();
    });
    nextBtn.addEventListener('click', () => {
      const idx  = getActiveIdx();
      const btns = getBtns();
      if (idx < btns.length - 1) btns[idx + 1].click();
    });

    modeRow._updateArrows = updateArrows;
    requestAnimationFrame(updateArrows);
  });
}

function _initRefRows() {
  _container.querySelectorAll('.chart-ref-row').forEach(refRow => {
    const scrollEl = refRow.querySelector('.chart-ref-scroll');
    const wrapEl   = refRow.querySelector('.chart-ref-scroll-wrap');
    const prevBtn  = refRow.querySelector('.chart-ref-prev');
    const nextBtn  = refRow.querySelector('.chart-ref-next');
    if (!scrollEl) return;

    _initScrollRow({ scrollEl, wrapEl, prevBtn, nextBtn, scrollPx: 100 });

    // Ref button clicks
    refRow.querySelectorAll('.chart-ref-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        const ref = btn.dataset.ref;
        if (ref === 'decade' || ref === 'year') {
          _openFallbackPopover(btn, refRow, ref);
        } else {
          _anomalyMode = ref;
          _anomalyRef  = null;
          _applyRefRows();
          if (_lastStationIds !== null) _loadData(_lastStationIds);
          _pushUrl();
        }
      });
    });

    // Picker hold-to-repeat
    const pickerRow  = refRow.closest('.chart-footer').querySelector('.chart-picker-row');
    if (pickerRow) {
      let _holdTimer = null, _holdInterval = null;
      const holdStart = dir => {
        _pickerStep(dir);
        _holdTimer = setTimeout(() => {
          _holdInterval = setInterval(() => _pickerStep(dir), 100);
        }, 350);
      };
      const holdEnd = () => { clearTimeout(_holdTimer); clearInterval(_holdInterval); _holdTimer = _holdInterval = null; };

      const pp = pickerRow.querySelector('.picker-prev');
      const pn = pickerRow.querySelector('.picker-next');
      pp.addEventListener('mousedown', () => holdStart(-1));
      pn.addEventListener('mousedown', () => holdStart(1));
      [pp, pn].forEach(b => {
        b.addEventListener('mouseup',    holdEnd);
        b.addEventListener('mouseleave', holdEnd);
        b.addEventListener('touchstart', e => { holdStart(b === pp ? -1 : 1); e.preventDefault(); }, { passive: false });
        b.addEventListener('touchend',   holdEnd);
      });
    }
  });

  // Fallback popover option clicks
  _container.querySelectorAll('.rfp-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const popover = opt.closest('.ref-fallback-popover');
      const ref = popover?.dataset.pendingRef;   // 'decade' or 'year'
      if (ref) _anomalyMode = ref;
      _anomalyFallback = opt.dataset.fallback === 'nearest';
      // Initialise ref to first available value if not already set
      if (_anomalyMode === 'decade' && _anomalyRef == null) _anomalyRef = _firstAvailableDecade();
      if (_anomalyMode === 'year'   && _anomalyRef == null) _anomalyRef = _firstAvailableYear();
      _closeFallbackPopovers();
      _applyRefRows();
      if (_lastStationIds !== null) _loadData(_lastStationIds);
      _pushUrl();
    });
  });

  // Close popover on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.ref-fallback-popover') && !e.target.closest('.chart-ref-btn[data-ref="decade"]') && !e.target.closest('.chart-ref-btn[data-ref="year"]')) {
      _closeFallbackPopovers();
    }
  }, { capture: true });
}

function _openFallbackPopover(btn, refRow, ref) {
  // Position the popover (fixed, escapes overflow:hidden ancestors)
  const popover     = refRow.querySelector('.ref-fallback-popover');
  const btnRect     = btn.getBoundingClientRect();
  const popoverW    = 240;
  const left        = Math.max(8, Math.min(btnRect.left, window.innerWidth - popoverW - 8));

  // Update selected state to reflect current settings for this ref type
  const isNearest = (_anomalyMode === ref && _anomalyFallback);
  popover.querySelectorAll('.rfp-option').forEach(o => {
    const sel = o.dataset.fallback === (isNearest ? 'nearest' : 'strict');
    o.classList.toggle('selected', sel);
    o.querySelector('.rfp-check').textContent = sel ? '✓' : '';
  });

  // Store which ref type this popover invocation is for so the option click knows
  popover.dataset.pendingRef = ref;

  popover.style.top  = (btnRect.bottom + 4) + 'px';
  popover.style.left = left + 'px';
  popover.hidden = false;

  // Lazily fetch coverage so chip gradient tints are ready when picker opens
  if (!_refCoverageCache && _lastStationIds?.length) {
    _fetchRefCoverage(_lastStationIds, 'qcf');
  }
}

function _closeFallbackPopovers() {
  _container?.querySelectorAll('.ref-fallback-popover').forEach(p => { p.hidden = true; });
}

// ── HTML builders ──────────────────────────────────────────────────────────────

function _buildHTML() {
  return `
    <div class="aggregate-header">
      <span class="aggregate-status"></span>
    </div>
    <div class="detail-sections">
      <div class="section-tabs-wrap">
        <div class="section-tabs" role="tablist" aria-label="Temperature series">
          <button class="section-tab active" role="tab"
                  data-agg-series="qcu" aria-selected="true">Unadjusted</button>
          <button class="section-tab" role="tab"
                  data-agg-series="qcf" aria-selected="false">Adjusted</button>
        </div>
      </div>
      ${_seriesPanel('qcu', false)}
      ${_seriesPanel('qcf', true)}
    </div>`;
}

function _seriesPanel(series, hidden) {
  return `
    <div class="section-panel" data-agg-series="${series}"${hidden ? ' hidden' : ''}>
      <div class="temp-chart-section">
        <div class="aggregate-loading-overlay" aria-hidden="true">
          <div class="aggregate-loading-spinner"></div>
        </div>
        <div class="chart-mode-row">
          <button class="chart-mode-arrow chart-mode-prev"
                  aria-label="Previous chart mode" hidden>‹</button>
          <div class="chart-mode-toggle" role="group" aria-label="Time resolution">
            <button class="chart-mode-btn" hidden
                    data-mode="monthly" aria-pressed="false">Monthly</button>
            <button class="chart-mode-btn" hidden
                    data-mode="bymonth" aria-pressed="false">By Month</button>
            <button class="chart-mode-btn" hidden
                    data-mode="yearly"  aria-pressed="false">Annual</button>
            <button class="chart-mode-btn"
                    data-mode="monthly-anomaly" aria-pressed="false">Monthly Anomaly</button>
            <button class="chart-mode-btn active"
                    data-mode="yearly-anomaly"  aria-pressed="true">Annual Anomaly</button>
          </div>
          <button class="chart-mode-arrow chart-mode-next"
                  aria-label="Next chart mode" hidden>›</button>
        </div>
        <div class="chart-controls-row">
          <div class="chart-trend-controls" role="group" aria-label="Chart overlays">
            <button class="chart-ci-btn active" data-action="trend-toggle"
                    title="Show or hide the linear trend line"
                    aria-pressed="true">Trend</button>
            <button class="chart-ci-btn" data-action="loess-toggle"
                    title="Show or hide LOESS smooth line"
                    aria-pressed="false">LOESS</button>
            <button class="chart-ci-btn active" data-action="geo-toggle"
                    title="Weight stations by cos(latitude) to approximate equal-area grid cells"
                    aria-pressed="true">Geo-gridded</button>
            <button class="chart-ci-btn active" data-action="fy-toggle"
                    title="Only include station-years with all 12 months present"
                    aria-pressed="true">Full years</button>
            <button class="chart-ci-btn active" data-action="ci-toggle"
                    title="Show 95% confidence interval shading (±1.96 × standard error)"
                    aria-pressed="true">95% CI</button>
          </div>
          <div class="chart-zoom-controls" role="group" aria-label="Zoom controls">
            <button class="chart-zoom-btn" data-action="zoom-out"
                    title="Zoom out" aria-label="Zoom out">−</button>
            <button class="chart-zoom-btn" data-action="zoom-reset"
                    title="Reset zoom" aria-label="Reset zoom">⊙</button>
            <button class="chart-zoom-btn" data-action="zoom-in"
                    title="Zoom in" aria-label="Zoom in">+</button>
          </div>
        </div>
        <div class="chart-canvas-wrap"></div>
        <div class="chart-month-toggles" hidden role="group" aria-label="Month selection">
          ${_monthToggleButtons()}
        </div>
        <div class="chart-footer">
          <p class="chart-hint">Drag to pan · Hover for temperature</p>
          <div class="chart-slider-row">
            <div class="chart-trend-from-controls" style="visibility:hidden">
              <label class="loess-slider-label">
                <span class="loess-slider-title">Trend From</span>
                <input type="range" class="trend-from-range"
                       min="0" max="201" step="1" value="0"
                       aria-label="Trend start year">
                <span class="trend-from-value">All</span>
              </label>
            </div>
            <span class="chart-slider-sep" style="visibility:hidden">|</span>
            <div class="chart-loess-controls" style="visibility:hidden">
              <div class="loess-slider-label">
                <span class="loess-slider-title">LOESS Smoothing</span>
                <input type="range" class="loess-range"
                       min="1" max="99" step="1" value="30"
                       aria-label="LOESS span">
                <button class="loess-mode-btn loess-span-btn active"
                        data-loess-mode="span" aria-pressed="true">0.30</button>
                <button class="loess-mode-btn loess-years-btn"
                        data-loess-mode="years" aria-pressed="false">— yr</button>
              </div>
            </div>
          </div>
          <div class="chart-ref-row" hidden aria-label="Anomaly baseline">
            <span class="chart-ref-label">Baseline</span>
            <button class="chart-mode-arrow chart-ref-prev" aria-label="Scroll baseline left" hidden>‹</button>
            <div class="scroll-fade-wrap chart-ref-scroll-wrap">
              <div class="chart-ref-scroll" role="group">
                <button class="chart-ref-btn active" data-ref="station">Station</button>
                <button class="chart-ref-btn" data-ref="auto_decade">Auto Decade…</button>
                <button class="chart-ref-btn" data-ref="auto_year">Auto Year…</button>
                <button class="chart-ref-btn" data-ref="decade">Decade ▾</button>
                <button class="chart-ref-btn" data-ref="year">Year ▾</button>
              </div>
            </div>
            <button class="chart-mode-arrow chart-ref-next" aria-label="Scroll baseline right" hidden>›</button>
            <div class="ref-fallback-popover" hidden role="menu" aria-label="Fallback mode">
              <button class="rfp-option selected" data-fallback="strict">
                <span class="rfp-check">✓</span>
                <span>Strict<span class="rfp-sub">exclude stations without this period</span></span>
              </button>
              <button class="rfp-option" data-fallback="nearest">
                <span class="rfp-check"></span>
                <span>Nearest match<span class="rfp-sub">use closest available period for missing stations</span></span>
              </button>
            </div>
          </div>
          <div class="chart-picker-row" hidden>
            <button class="picker-arrow-btn picker-prev" aria-label="Previous">‹</button>
            <div class="picker-scroll"><div class="picker-track"></div></div>
            <button class="picker-arrow-btn picker-next" aria-label="Next">›</button>
          </div>
        </div>
      </div>
    </div>`;
}

function _monthToggleButtons() {
  return MONTHS.map((name, i) => {
    const active = (BYMONTH_DEFAULT_MASK >> i) & 1 ? 'active' : '';
    const dash   = MONTH_DASH[i].length === 0 ? 'solid'
                 : MONTH_DASH[i][0] >= 5       ? 'dashed'
                 :                               'dotted';
    return `<button class="month-toggle-btn ${active}" data-month="${i}"
              data-dash="${dash}" style="--m-color:var(--month-${i})"
              aria-pressed="${active ? 'true' : 'false'}">${name}</button>`;
  }).join('');
}
