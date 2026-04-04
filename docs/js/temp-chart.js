/**
 * Temperature chart — canvas-based line and heatmap plots for GHCNm data.
 *
 * Modes:
 *   'monthly'  — line chart, one point per month
 *   'yearly'   — line chart, one point per annual average
 *   'heatmap'  — calendar grid: year × month, cell colour = temperature
 *   'anomaly'  — line chart, annual average temperature anomaly
 *
 * All modes share a single x-axis domain (_xMin / _xMax in fractional years).
 * Switching modes preserves the current zoom range.  Heatmap rendering snaps
 * the domain to integer year boundaries for display.
 *
 * Usage:
 *   const chart = new TempChart(containerEl);
 *   chart.load(csvText);              // parse and render; empty/null = no data
 *   chart.setGlobalRange(min, max);   // set the shared x range from outside
 *   chart.setMode('heatmap');         // 'monthly' | 'yearly' | 'heatmap' | 'anomaly'
 *   chart.resize();                   // call when container becomes visible
 *   chart.destroy();                  // cleanup on panel close
 *
 * Interaction:
 *   Drag to pan.  Use zoomIn() / zoomOut() / resetZoom() for zoom.
 *   Hover shows a vertical inspector line (line charts) or cell outline (heatmap).
 *
 * Events dispatched on the container element (bubbles):
 *   'chart:zoom'    — fired after zoom or pan ends
 *   'chart:inspect' — fired (debounced 300 ms) when inspector position changes
 */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Data parsing ───────────────────────────────────────────────────────────────

/**
 * Parse GHCNm CSV text (no header row).
 * Format: year, jan, feb, …, dec  — values in 0.01 °C integers, empty = missing.
 */
function _parseCsv(text) {
  if (!text || !text.trim()) return [];
  const records = [];
  for (const line of text.trim().split('\n')) {
    const cols = line.trim().split(',');
    if (cols.length < 2) continue;
    const year = parseInt(cols[0], 10);
    if (!isFinite(year)) continue;
    const months = [];
    for (let m = 0; m < 12; m++) {
      const raw = (cols[m + 1] ?? '').trim();
      months.push(raw !== '' ? parseInt(raw, 10) : null);
    }
    records.push({ year, months });
  }
  return records.sort((a, b) => a.year - b.year);
}

/**
 * Build point array for monthly display.
 * Nulls appear for missing months and gaps between non-adjacent years (line break).
 */
function _monthlyPoints(records) {
  const pts = [];
  let prevYear = null;
  for (const rec of records) {
    if (prevYear !== null && rec.year > prevYear + 1) pts.push(null);
    prevYear = rec.year;
    for (let m = 0; m < 12; m++) {
      pts.push(rec.months[m] != null
        ? { x: rec.year + m / 12, y: rec.months[m] / 100, label: `${MONTHS[m]} ${rec.year}` }
        : null);
    }
  }
  return pts;
}

/**
 * Build point array for annual-average display.
 * Only complete years (all 12 months present) are included.
 * Year gaps between consecutive complete years produce null (line break).
 * Partial years are handled separately via _calibrateAndEstimate().
 */
function _yearlyPoints(records) {
  const pts = [];
  let prevYear = null;
  for (const rec of records) {
    if (!rec.months.every(v => v != null)) continue; // skip partial years
    if (prevYear !== null && rec.year > prevYear + 1) pts.push(null);
    const avg = rec.months.reduce((s, v) => s + v, 0) / 12 / 100;
    pts.push({ x: rec.year, y: avg, label: String(rec.year) });
    prevYear = rec.year;
  }
  return pts;
}

/**
 * Build annual mean summaries from all years with at least one valid month.
 * @param {Array<{year: number, months: (number|null)[]}>} records
 * @returns {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>}
 */
function _annualSummaries(records) {
  return records
    .map(rec => {
      const months = rec.months.filter(v => v != null);
      if (months.length === 0) return null;
      return {
        year:    rec.year,
        mean:    months.reduce((sum, v) => sum + v, 0) / months.length / 100,
        nMonths: months.length,
        isFull:  months.length === 12,
      };
    })
    .filter(Boolean);
}

/**
 * Pick the full years used as the annual anomaly reference.
 * @param {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>} summaries
 * @param {boolean} useCenteredReference
 * @returns {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>}
 */
function _anomalyReferenceYears(summaries, useCenteredReference) {
  const fullYears = summaries.filter(s => s.isFull);
  if (fullYears.length === 0) return [];

  if (useCenteredReference && fullYears.length > 30) {
    const center = (fullYears[0].year + fullYears[fullYears.length - 1].year) / 2;
    return [...fullYears]
      .sort((a, b) => {
        const da = Math.abs(a.year - center);
        const db = Math.abs(b.year - center);
        return da - db || a.year - b.year;
      })
      .slice(0, 30)
      .sort((a, b) => a.year - b.year);
  }
  return fullYears;
}

/**
 * Build annual anomaly points from annual summaries.
 * Reference mean is always computed from full years only.
 * @param {Array<{year: number, mean: number, nMonths: number, isFull: boolean}>} summaries
 * @param {{ excludeSparse: boolean, useCenteredReference: boolean }} options
 * @returns {Array<{x: number, y: number, label: string, nMonths: number, isFull: boolean}>}
 */
function _anomalyPoints(summaries, options = {}) {
  const excludeSparse = options.excludeSparse !== false;
  const useCenteredReference = !!options.useCenteredReference;
  const referenceYears = _anomalyReferenceYears(summaries, useCenteredReference);
  if (referenceYears.length === 0) return [];

  const referenceMean = referenceYears.reduce((sum, s) => sum + s.mean, 0) / referenceYears.length;
  const included = summaries.filter(s => excludeSparse ? s.nMonths >= 9 : s.nMonths >= 1);

  const pts = [];
  let prevYear = null;
  for (const summary of included) {
    if (prevYear !== null && summary.year > prevYear + 1) pts.push(null);
    pts.push({
      x:       summary.year,
      y:       summary.mean - referenceMean,
      label:   String(summary.year),
      nMonths: summary.nMonths,
      isFull:  summary.isFull,
    });
    prevYear = summary.year;
  }
  return pts;
}

/**
 * Compute a least-squares trend line for point data.
 * @param {Array<{x: number, y: number}|null>} pts
 * @returns {{ slopePerYear: number, slopePer100Years: number, intercept: number }|null}
 */
function _trendLine(pts) {
  const values = (pts ?? []).filter(Boolean);
  if (values.length < 2) return null;

  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const p of values) {
    sumX += p.x;
    sumY += p.y;
    sumXX += p.x * p.x;
    sumXY += p.x * p.y;
  }

  const n = values.length;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;

  const slopePerYear = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slopePerYear * sumX) / n;
  return {
    slopePerYear,
    slopePer100Years: slopePerYear * 100,
    intercept,
  };
}

// ── Matrix inversion (Gauss-Jordan) ───────────────────────────────────────────

/**
 * Invert an n×n matrix using Gauss-Jordan elimination.
 * Returns null if the matrix is singular (pivot < 1e-12).
 * @param {number[][]} A
 * @returns {number[][]|null}
 */
function _matInverse(A) {
  const n = A.length;
  // Build augmented matrix [A | I]
  const M = A.map((row, i) => {
    const aug = row.map(v => v);
    for (let j = 0; j < n; j++) aug.push(j === i ? 1 : 0);
    return aug;
  });

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) return null; // singular

    const invPivot = 1 / pivot;
    for (let j = 0; j < 2 * n; j++) M[col][j] *= invPivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = M[row][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[row][j] -= f * M[col][j];
    }
  }

  return M.map(row => row.slice(n));
}

// ── GLS partial-year estimator ────────────────────────────────────────────────

/**
 * Calibrate a month-to-annual estimator from complete years, then apply GLS
 * to estimate annual means for partial years (with 95% CI).
 *
 * All arithmetic is performed in Kelvin (raw units: 0.01 K, i.e. add 27315 to
 * each 0.01 °C value) so that monthly means are always ~27000–31000 and the
 * ratio estimator E[y,i] = A·t[y,i]/T[i] is never subject to division by a
 * value near zero.
 *
 * Algorithm:
 *   T[i]    = climatological monthly mean (0.01 K) across complete years
 *   A       = mean(T[0..11])  — grand climatological mean in Kelvin
 *   E[y,i]  = A · t_K[y,i] / T[i]  — month-implied annual estimate (0.01 K)
 *   A_y     = mean of 12 Kelvin values for complete year y
 *   r[y,i]  = E[y,i] − A_y  — residual
 *   Sigma   = 12×12 sample covariance of residuals (across complete years)
 *
 *   For each partial year: GLS combining the k observed E[y,i] values with the
 *   k×k covariance submatrix; falls back to inverse-variance if submatrix is singular.
 *
 * @param {Array<{year: number, months: (number|null)[]}>} records  — values in 0.01 °C
 * @returns {Array<{year, estimate, se, ciLow, ciHigh, nMonths}>}   — all values in °C
 */
function _calibrateAndEstimate(records) {
  const complete = records.filter(r => r.months.every(v => v != null));
  const partial  = records.filter(r =>
    !r.months.every(v => v != null) && r.months.some(v => v != null));

  if (complete.length < 3 || partial.length === 0) return [];

  // Work in 0.01 K throughout: offset each raw 0.01 °C value by +27315.
  const K = 27315;

  // T[i] = climatological monthly mean in 0.01 K
  const T = new Array(12).fill(0);
  for (const yr of complete) {
    for (let i = 0; i < 12; i++) T[i] += yr.months[i] + K;
  }
  for (let i = 0; i < 12; i++) T[i] /= complete.length;

  // A = grand annual mean in 0.01 K
  const A = T.reduce((s, v) => s + v, 0) / 12;

  // Build E[y,i] and A_y for complete years, then compute residuals.
  const residuals = complete.map(yr => {
    const Ay = yr.months.reduce((s, v) => s + v + K, 0) / 12;
    return yr.months.map((v, i) => (A * (v + K) / T[i]) - Ay);
  });

  // 12×12 sample covariance matrix of residuals
  const n = complete.length;
  const Sigma = Array.from({ length: 12 }, () => new Array(12).fill(0));
  for (let i = 0; i < 12; i++) {
    for (let j = i; j < 12; j++) {
      let cov = 0;
      for (const r of residuals) cov += r[i] * r[j];
      Sigma[i][j] = Sigma[j][i] = cov / (n - 1);
    }
  }

  // Estimate each partial year via GLS
  const results = [];
  for (const rec of partial) {
    const obsIdx = rec.months.reduce((acc, v, i) => { if (v != null) acc.push(i); return acc; }, []);
    if (obsIdx.length === 0) continue;

    // Month-implied annual estimates in 0.01 K
    const ES = obsIdx.map(i => A * (rec.months[i] + K) / T[i]);

    const k = obsIdx.length;
    let hatA, se;

    const SigmaS = Array.from({ length: k }, (_, ri) =>
      Array.from({ length: k }, (_, ci) => Sigma[obsIdx[ri]][obsIdx[ci]])
    );
    const SigmaSInv = _matInverse(SigmaS);

    if (SigmaSInv) {
      // GLS: hat_A = (1^T Sigma_S^{-1} 1)^{-1} * 1^T Sigma_S^{-1} * E_S
      let denom = 0, numer = 0;
      for (let ri = 0; ri < k; ri++) {
        let rowSumInv = 0, rowSumInvE = 0;
        for (let ci = 0; ci < k; ci++) {
          rowSumInv  += SigmaSInv[ri][ci];
          rowSumInvE += SigmaSInv[ri][ci] * ES[ci];
        }
        denom += rowSumInv;
        numer += rowSumInvE;
      }
      if (denom <= 0) continue;
      hatA = numer / denom;
      se   = Math.sqrt(1 / denom);
    } else {
      // Fallback: inverse-variance weighting (diagonal only)
      let sumW = 0, sumWE = 0;
      for (let ki = 0; ki < k; ki++) {
        const v = Sigma[obsIdx[ki]][obsIdx[ki]];
        if (v <= 0) continue;
        const w = 1 / v;
        sumW  += w;
        sumWE += w * ES[ki];
      }
      if (sumW <= 0) continue;
      hatA = sumWE / sumW;
      se   = Math.sqrt(1 / sumW);
    }

    // Convert from 0.01 K back to °C: subtract Kelvin offset then scale.
    const estimate = (hatA - K) / 100;
    const seDeg    = se / 100;   // SE is a difference, no offset needed
    results.push({
      year:    rec.year,
      estimate,
      se:      seDeg,
      ciLow:   estimate - 1.96 * seDeg,
      ciHigh:  estimate + 1.96 * seDeg,
      nMonths: k,
    });
  }

  return results;
}

// ── Axis / colour helpers ──────────────────────────────────────────────────────

/** Pick a tick step giving ~targetCount ticks across range. */
function _niceStep(range, targetCount) {
  if (range <= 0 || !isFinite(range)) return 1;
  const rough = range / targetCount;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const n     = rough / mag;
  const step  = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * mag;
}

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Map a normalised value t ∈ [-1, 1] to an [R, G, B] array.
 * t = -1 → cold blue, t = 0 → theme mid (black in dark / white in light), t = +1 → hot red.
 */
function _heatColor(t, isLight) {
  const clamp = x => Math.max(0, Math.min(255, Math.round(x)));
  const COLD = [10,  50, 220];
  const HOT  = [220, 25,  10];
  const MID  = isLight ? [244, 240, 232] : [10, 16, 24];
  const [from, to, f] = t <= 0 ? [MID, COLD, -t] : [MID, HOT, t];
  return from.map((c, i) => clamp(c + (to[i] - c) * f));
}

// ── TempChart ─────────────────────────────────────────────────────────────────

export class TempChart {
  /** @param {HTMLElement} container - .chart-canvas-wrap element */
  constructor(container) {
    this._container = container;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'temp-chart-canvas';
    this._canvas.style.cursor = 'grab';
    container.appendChild(this._canvas);

    this._tooltip = document.createElement('div');
    this._tooltip.className = 'chart-tooltip';
    this._tooltip.hidden = true;
    container.appendChild(this._tooltip);

    // DOM references for heatmap legend (sibling elements in .temp-chart-section)
    const section = container.parentElement;
    this._heatLegend = section?.querySelector('.chart-heat-legend')  ?? null;
    this._coldLabel  = section?.querySelector('.heat-cold-label')    ?? null;
    this._hotLabel   = section?.querySelector('.heat-hot-label')     ?? null;

    this._records          = null;
    this._monthly          = null;
    this._yearly           = null;
    this._annualSummaries  = null;
    this._anomaly          = null;
    this._anomalyTrend     = null;
    this._anomalyReferenceWindow = null;
    this._partialEstimates = null;  // [{year, estimate, se, ciLow, ciHigh, nMonths}]
    this._recordMap        = new Map();   // year → months[]
    this._mode             = 'monthly';
    this._showEst          = true;   // show partial-year estimate line + dots
    this._showCI           = true;   // show 95% CI error bars (only when _showEst is true)
    this._excludeSparseAnomalyYears = true;
    this._useCenteredAnomalyReference = false;
    this._showAnomalyTrend = true;

    // ── Unified x-axis domain (fractional years, shared across all modes) ──
    // null until load() or setGlobalRange() initialises them.
    this._xMin       = null;  // current view left edge
    this._xMax       = null;  // current view right edge
    this._xMinPadded = null;  // hard left boundary (heatmap-snapped minimum)
    this._globalXMin = null;  // reset target left edge
    this._globalXMax = null;  // reset target right edge

    // Per-chart data extent (reported to detail-panel.js for union calculation).
    this._dataXMin = null;
    this._dataXMax = null;

    this._dpr = window.devicePixelRatio || 1;
    this._raf = null;

    // Inspector state — vertical line for line charts, cell for heatmap.
    this._hoverX         = null;   // x in data space where the inspector line sits
    this._hoveredPt      = null;   // nearest complete-year point to _hoverX (for tooltip)
    this._hoveredPartial = null;   // nearest partial-year estimate to _hoverX (for tooltip)
    this._hoveredCell    = null;   // heatmap hover { year, month, value }

    // Drag-to-pan state.
    this._isDragging      = false;
    this._dragStartMouseX = 0;
    this._dragStartXMin   = 0;
    this._dragStartXMax   = 0;

    // Debounce timer for chart:inspect event.
    this._inspDebounce = null;

    // Geometry from last render (CSS px), used by mouse hit-testing.
    this._geom = null;

    // Margins in CSS px — different for each mode.
    this._LINE_M = { l: 52, r: 16, t: 12, b: 36 };
    this._HEAT_M = { l: 44, r: 16, t:  8, b: 28 };

    // Bind handlers.
    this._onMouseDown  = this._onMouseDown.bind(this);
    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._docMouseMove = (e) => { if (this._isDragging) this._doPan(e); };
    this._docMouseUp   = (e) => {
      if (!this._isDragging) return;
      this._isDragging = false;
      document.removeEventListener('mousemove', this._docMouseMove);
      document.removeEventListener('mouseup',   this._docMouseUp);
      this._canvas.style.cursor = 'grab';
      this._dispatchZoomChange();
      this._onMouseMove(e);
    };

    this._canvas.addEventListener('mousedown',  this._onMouseDown);
    this._canvas.addEventListener('mousemove',  this._onMouseMove);
    this._canvas.addEventListener('mouseleave', this._onMouseLeave);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  load(csvText) {
    const records = _parseCsv(csvText || '');
    this._records = records;

    if (records.length === 0) {
      this._monthly          = null;
      this._yearly           = null;
      this._annualSummaries  = null;
      this._anomaly          = null;
      this._anomalyTrend     = null;
      this._anomalyReferenceWindow = null;
      this._partialEstimates = null;
      this._recordMap        = new Map();
      this._scheduleRender();
      return;
    }

    this._monthly          = _monthlyPoints(records);
    this._yearly           = _yearlyPoints(records);
    this._annualSummaries  = _annualSummaries(records);
    this._anomaly          = _anomalyPoints(this._annualSummaries, {
      excludeSparse: this._excludeSparseAnomalyYears,
      useCenteredReference: this._useCenteredAnomalyReference,
    });
    const referenceYears = _anomalyReferenceYears(
      this._annualSummaries,
      this._useCenteredAnomalyReference,
    );
    this._anomalyTrend     = _trendLine(this._anomaly);
    this._anomalyReferenceWindow = referenceYears.length
      ? { start: referenceYears[0].year, end: referenceYears[referenceYears.length - 1].year }
      : null;
    this._partialEstimates = _calibrateAndEstimate(records);
    this._recordMap        = new Map(records.map(r => [r.year, r.months]));

    const allX = this._monthly.filter(Boolean).map(p => p.x);
    this._dataXMin = Math.min(...allX);
    this._dataXMax = Math.max(...allX);

    // If the global range hasn't been set externally yet, initialise from this
    // chart's own data.  setGlobalRange() (called once both charts have loaded)
    // will override this with the cross-chart union range.
    if (this._globalXMin === null) {
      this._initRangeFromData(this._dataXMin, this._dataXMax);
    }

    this.resize();
  }

  /**
   * Override the x-axis range used by all modes for this chart.
   * Called by detail-panel.js with the union of all loaded charts' data ranges
   * so that both QCU and QCF always share the same initial / reset domain.
   *
   * @param {number} min  — left edge (fractional year)
   * @param {number} max  — right edge (fractional year)
   */
  setGlobalRange(min, max) {
    this._initRangeFromData(min, max);
    this._scheduleRender();
  }

  /**
   * The data extent for this chart (used by detail-panel.js to compute the union).
   * Returns null if data has not yet been loaded.
   * @returns {{ min: number, max: number }|null}
   */
  getDataRange() {
    if (this._dataXMin === null) return null;
    return { min: this._dataXMin, max: this._dataXMax };
  }

  setMode(mode) {
    const prev = this._mode;
    this._mode = mode;

    // Clear hover state on mode change.
    this._hoverX      = null;
    this._hoveredPt   = null;
    this._hoveredCell = null;
    this._tooltip.hidden = true;

    // Toggle heatmap height class on the container.
    this._container.classList.toggle('heatmap', mode === 'heatmap');

    // Show / hide HTML legend.
    if (this._heatLegend) this._heatLegend.hidden = mode !== 'heatmap';

    if (mode !== prev) {
      requestAnimationFrame(() => { this.resize(); });
    }
    this._scheduleRender();
  }

  resize() {
    const w = this._container.clientWidth;
    const h = this._container.clientHeight;
    if (!w || !h) return;

    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    this._canvas.width  = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    this._canvas.style.width  = w + 'px';
    this._canvas.style.height = h + 'px';
    this._scheduleRender();
  }

  destroy() {
    this._ro.disconnect();
    this._canvas.removeEventListener('mousedown',  this._onMouseDown);
    this._canvas.removeEventListener('mousemove',  this._onMouseMove);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    document.removeEventListener('mousemove', this._docMouseMove);
    document.removeEventListener('mouseup',   this._docMouseUp);
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._inspDebounce);
  }

  /** Zoom in by ~25%, centred on current view midpoint. */
  zoomIn()  { this._zoom(1 / 1.25); }

  /** Zoom out by ~25%, centred on current view midpoint. */
  zoomOut() { this._zoom(1.25); }

  /** Reset zoom to the full global (cross-chart union) data range. */
  resetZoom() {
    if (this._globalXMin === null) return;
    this._xMin = this._globalXMin;
    this._xMax = this._globalXMax;
    this._scheduleRender();
    this._dispatchZoomChange();
  }

  /** Show or hide the partial-year estimate line + dots (yearly mode). */
  setShowEst(v) { this._showEst = !!v; this._scheduleRender(); }

  /** @returns {boolean} */
  getShowEst() { return this._showEst; }

  /** Show or hide 95% CI error bars for partial-year estimates (yearly mode, requires showEst). */
  setShowCI(v) { this._showCI = !!v; this._scheduleRender(); }

  /** @returns {boolean} */
  getShowCI() { return this._showCI; }

  setExcludeSparseAnomalyYears(v) {
    this._excludeSparseAnomalyYears = !!v;
    this._rebuildAnomaly();
  }

  getExcludeSparseAnomalyYears() {
    return this._excludeSparseAnomalyYears;
  }

  setUseCenteredAnomalyReference(v) {
    this._useCenteredAnomalyReference = !!v;
    this._rebuildAnomaly();
  }

  getUseCenteredAnomalyReference() {
    return this._useCenteredAnomalyReference;
  }

  setShowAnomalyTrend(v) {
    this._showAnomalyTrend = !!v;
    this._scheduleRender();
  }

  getShowAnomalyTrend() {
    return this._showAnomalyTrend;
  }

  /**
   * Get the current view range (same for all modes).
   * @returns {{ min: number, max: number }|null}
   */
  getZoom() {
    if (this._xMin === null) return null;
    return { min: this._xMin, max: this._xMax };
  }

  /**
   * Set the view range (applies to all modes).
   * @param {number} min
   * @param {number} max
   */
  setZoom(min, max) {
    if (this._xMinPadded === null) return;
    this._xMin = Math.max(this._xMinPadded, min);
    this._xMax = Math.min(this._globalXMax, max);
    this._scheduleRender();
  }

  /**
   * Get the current inspector position.
   * @returns {{ type: 'line', x: number }|{ type: 'heat', year: number, month: number }|null}
   */
  getInspector() {
    if (this._mode === 'heatmap') {
      return this._hoveredCell
        ? { type: 'heat', year: this._hoveredCell.year, month: this._hoveredCell.month }
        : null;
    }
    return this._hoverX !== null ? { type: 'line', x: this._hoverX } : null;
  }

  /**
   * Set the inspector position for line charts (snaps to nearest data point).
   * @param {number} x - fractional year
   */
  setInspector(x) {
    this._hoverX = x;
    const pts = this._linePts();
    if (pts) {
      let best = null, bestDist = Infinity;
      for (const p of pts) {
        if (!p) continue;
        const d = Math.abs(p.x - x);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      this._hoveredPt = best;
      if (best) this._hoverX = best.x;
    }
    this._scheduleRender();
  }

  /**
   * Set the inspector to a specific heatmap cell.
   * @param {number} year
   * @param {number} month  — 0-based
   */
  setInspectorCell(year, month) {
    const months = this._recordMap.get(year);
    const raw = months ? months[month] : null;
    this._hoveredCell = { year, month, value: raw };
    this._scheduleRender();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  _linePts() {
    if (this._mode === 'yearly') return this._yearly;
    if (this._mode === 'anomaly') return this._anomaly;
    return this._monthly;
  }

  _rebuildAnomaly() {
    this._anomaly = _anomalyPoints(this._annualSummaries ?? [], {
      excludeSparse: this._excludeSparseAnomalyYears,
      useCenteredReference: this._useCenteredAnomalyReference,
    });
    const referenceYears = _anomalyReferenceYears(
      this._annualSummaries ?? [],
      this._useCenteredAnomalyReference,
    );
    this._anomalyTrend = _trendLine(this._anomaly);
    this._anomalyReferenceWindow = referenceYears.length
      ? { start: referenceYears[0].year, end: referenceYears[referenceYears.length - 1].year }
      : null;
    this._scheduleRender();
  }

  /**
   * Initialise the x-axis domain from a data range [min, max].
   * Computes the padded left boundary (heatmap 50-year snap) and resets the
   * current view to the full global range.
   */
  _initRangeFromData(min, max) {
    const span = max - min;
    this._xMinPadded = span < 100
      ? Math.floor(min / 50) * 50
      : Math.floor(min);
    this._globalXMin = this._xMinPadded;
    this._globalXMax = Math.ceil(max);
    this._xMin = this._globalXMin;
    this._xMax = this._globalXMax;
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
  }

  _dispatchZoomChange() {
    this._container.dispatchEvent(new CustomEvent('chart:zoom', { bubbles: true }));
  }

  _dispatchInspectorChange() {
    clearTimeout(this._inspDebounce);
    this._inspDebounce = setTimeout(() => {
      this._container.dispatchEvent(new CustomEvent('chart:inspect', { bubbles: true }));
    }, 300);
  }

  _zoom(factor) {
    if (this._xMin === null) return;
    const mid    = (this._xMin + this._xMax) / 2;
    let newMin   = mid - (mid - this._xMin) * factor;
    let newMax   = mid + (this._xMax - mid) * factor;

    const isHeat = this._mode === 'heatmap';
    if (isHeat) {
      newMin = Math.floor(newMin);
      newMax = Math.ceil(newMax);
    }

    newMin = Math.max(this._xMinPadded, newMin);
    newMax = Math.min(this._globalXMax, newMax);

    // Enforce mode-appropriate minimum span.
    const minSpan = isHeat ? 5 : 0.5;
    if (newMax - newMin < minSpan) return;

    this._xMin = newMin;
    this._xMax = newMax;
    this._scheduleRender();
    this._dispatchZoomChange();
  }

  // ── Top-level render dispatcher ───────────────────────────────────────────────

  _render() {
    const canvas = this._canvas;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;

    const dpr  = this._dpr;
    const rawM = this._mode === 'heatmap' ? this._HEAT_M : this._LINE_M;
    const ml   = rawM.l * dpr, mr = rawM.r * dpr;
    const mt   = rawM.t * dpr, mb = rawM.b * dpr;
    const cw   = W - ml - mr;
    const ch   = H - mt - mb;

    // Store CSS-px geometry for mouse hit-testing.
    this._geom = { ml: rawM.l, mr: rawM.r, mt: rawM.t, mb: rawM.b,
                   cw: cw / dpr, ch: ch / dpr };

    ctx.clearRect(0, 0, W, H);

    if (this._mode === 'heatmap') {
      this._renderHeatmap(ctx, W, H, dpr, ml, mr, mt, mb, cw, ch);
    } else {
      this._renderLine(ctx, W, H, dpr, ml, mr, mt, mb, cw, ch);
    }
  }

  // ── Line chart rendering ──────────────────────────────────────────────────────

  _renderLine(ctx, W, H, dpr, ml, mr, mt, mb, cw, ch) {
    const colGrid     = _cssVar('--border-color') || 'rgba(212,168,85,0.2)';
    const colText     = _cssVar('--text-muted')   || '#5a6880';
    const colBg       = _cssVar('--bg-elevated')  || '#152c4a';
    const isLight     = document.documentElement.dataset.theme === 'light';
    const isAnomaly   = this._mode === 'anomaly';
    const colLine     = isAnomaly
      ? (isLight ? '#9a2f00' : '#ff9a5a')
      : (isLight ? '#2060b0' : '#5090e0');
    const colZero     = isLight ? 'rgba(0,80,180,0.22)' : 'rgba(80,144,224,0.22)';
    const colInsp     = isLight ? 'rgba(0,80,180,0.45)' : 'rgba(80,144,224,0.5)';
    const colPartial  = isLight ? '#c05020' : '#e09040';
    const colPartialCI = isLight ? 'rgba(192,80,32,0.35)' : 'rgba(224,144,64,0.35)';
    const colTrend    = isLight ? '#2060b0' : '#7fb2ff';
    const colRef      = isLight ? 'rgba(90, 100, 115, 0.75)' : 'rgba(190, 196, 205, 0.75)';

    const pts  = this._linePts();
    const xMin = this._xMin, xMax = this._xMax;

    // Partial-year estimates are only shown in yearly mode when Est. is toggled on.
    const visiblePartials = (this._mode === 'yearly' && this._showEst && this._partialEstimates)
      ? this._partialEstimates.filter(pe => pe.year >= xMin && pe.year <= xMax)
      : [];

    const visible = pts ? pts.filter(p => p && p.x >= xMin && p.x <= xMax) : [];

    if ((!pts || pts.length === 0) && visiblePartials.length === 0) {
      ctx.fillStyle = colText;
      ctx.font = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this._mode === 'anomaly'
        ? 'Need at least one complete year for anomaly reference'
        : 'No temperature data available', W / 2, H / 2);
      return;
    }

    if (visible.length < 1 && visiblePartials.length < 1) {
      ctx.fillStyle = colText;
      ctx.font = `${12 * dpr}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Zoom out to see data', W / 2, H / 2);
      return;
    }

    // Y-axis range is anchored to visible complete-year points. Partial-year
    // estimate centres may expand that raw range by at most 10%; CI bars are
    // clipped to the final domain and do not influence it.
    let yMin = Infinity, yMax = -Infinity;
    for (const p of visible) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }

    if (!isFinite(yMin)) {
      for (const pe of visiblePartials) {
        if (pe.estimate < yMin) yMin = pe.estimate;
        if (pe.estimate > yMax) yMax = pe.estimate;
      }
    } else if (!isAnomaly && visiblePartials.length > 0) {
      const baseMin = yMin;
      const baseMax = yMax;
      const baseSpan = Math.max(baseMax - baseMin, 1);
      const estExt = baseSpan * 0.1;
      const estMin = Math.min(...visiblePartials.map(pe => pe.estimate));
      const estMax = Math.max(...visiblePartials.map(pe => pe.estimate));
      yMin = Math.max(baseMin - estExt, Math.min(baseMin, estMin));
      yMax = Math.min(baseMax + estExt, Math.max(baseMax, estMax));
    }

    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    if (yMin === yMax)   { yMin -= 0.5; yMax += 0.5; }

    const dataSpan = yMax - yMin;
    const yPad     = dataSpan * 0.1;
    yMin -= yPad; yMax += yPad;

    const toX = x => ml + (x - xMin) / (xMax - xMin) * cw;
    const toY = y => mt + (yMax - y) / (yMax - yMin) * ch;

    // Y grid + labels
    const yStep  = _niceStep(yMax - yMin, 5);
    const yStart = Math.ceil(yMin / yStep) * yStep;
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = yStart; y < yMax + yStep * 0.01; y += yStep) {
      if (y < yMin - 1e-9) continue;
      const py = toY(y);
      ctx.strokeStyle = colGrid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ml, py); ctx.lineTo(ml + cw, py); ctx.stroke();
      const dec = Math.max(0, -Math.floor(Math.log10(yStep)));
      ctx.fillStyle = colText;
      ctx.fillText(y.toFixed(dec) + '°C', ml - 5 * dpr, py);
    }

    // X grid + labels
    const xStep  = _niceStep(xMax - xMin, 6);
    const xStart = Math.ceil(xMin / xStep) * xStep;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = xStart; x <= xMax + xStep * 0.01; x += xStep) {
      const px = toX(x);
      if (px < ml - 0.5 || px > ml + cw + 0.5) continue;
      ctx.strokeStyle = colGrid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, mt); ctx.lineTo(px, mt + ch); ctx.stroke();
      ctx.fillStyle = colText;
      ctx.fillText(String(Math.round(x)), px, mt + ch + 5 * dpr);
    }

    // Dashed zero line
    if (yMin < 0 && yMax > 0) {
      const py0 = toY(0);
      ctx.strokeStyle = colZero; ctx.lineWidth = 1.5;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(ml, py0); ctx.lineTo(ml + cw, py0); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(ml - 0.5, mt - 0.5, cw + 1, ch + 1); ctx.clip();

    // Inspector vertical line (drawn before data so data renders on top).
    if (this._hoverX !== null && this._hoverX >= xMin && this._hoverX <= xMax) {
      const px = toX(this._hoverX);
      ctx.strokeStyle = colInsp;
      ctx.lineWidth   = 1 * dpr;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(px, mt);
      ctx.lineTo(px, mt + ch);
      ctx.stroke();
    }

    if (isAnomaly && this._useCenteredAnomalyReference && this._anomalyReferenceWindow) {
      const markers = [
        this._anomalyReferenceWindow.start - 0.5,
        this._anomalyReferenceWindow.end + 0.5,
      ];
      ctx.strokeStyle = colRef;
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      for (const markerX of markers) {
        if (markerX < xMin || markerX > xMax) continue;
        const px = toX(markerX);
        ctx.beginPath();
        ctx.moveTo(px, mt);
        ctx.lineTo(px, mt + ch);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (isAnomaly && this._showAnomalyTrend && this._anomalyTrend) {
      const trendStartY = this._anomalyTrend.intercept + this._anomalyTrend.slopePerYear * xMin;
      const trendEndY   = this._anomalyTrend.intercept + this._anomalyTrend.slopePerYear * xMax;
      ctx.strokeStyle = colTrend;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(toX(xMin), toY(trendStartY));
      ctx.lineTo(toX(xMax), toY(trendEndY));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Partial-year estimates (CI toggle ON only) ────────────────────────────
    // Renders: CI bars → amber connecting line → complete-year line → amber dots
    // (layer order ensures blue line overlaps amber at shared endpoints, dots are topmost)
    if (!isAnomaly && visiblePartials.length > 0) {
      const CAP_W = 4 * dpr;

      // 1. CI bars (most rearward; only when the 95% CI toggle is also on)
      if (this._showCI) {
        for (const pe of visiblePartials) {
          const px    = toX(pe.year);
          const pyLow = toY(Math.max(pe.ciLow,  yMin));
          const pyHi  = toY(Math.min(pe.ciHigh, yMax));
          ctx.strokeStyle = colPartialCI; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(px, pyLow); ctx.lineTo(px, pyHi); ctx.stroke();
          ctx.strokeStyle = colPartial;   ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.moveTo(px - CAP_W / 2, pyLow); ctx.lineTo(px + CAP_W / 2, pyLow);
          ctx.moveTo(px - CAP_W / 2, pyHi);  ctx.lineTo(px + CAP_W / 2, pyHi);
          ctx.stroke();
        }
      }

      // 2. Amber connecting line: for each contiguous partial-year run, draw a line
      //    that starts at the preceding complete year, passes through all partial
      //    estimates in the run, and ends at the following complete year.
      //    This bridges the gaps in the blue complete-year line.
      if (this._partialEstimates) {
        const compMap = new Map((pts ?? []).filter(Boolean).map(p => [Math.round(p.x), p]));
        const partMap = new Map(this._partialEstimates.map(pe => [pe.year, pe]));
        const allYrs  = [...new Set([
          ...(pts ?? []).filter(Boolean).map(p => Math.round(p.x)),
          ...this._partialEstimates.map(pe => pe.year),
        ])].sort((a, b) => a - b);

        for (let i = 0; i < allYrs.length; ) {
          if (!partMap.has(allYrs[i])) { i++; continue; }

          // Build bridge segment for this partial run.
          const seg = [];

          // Preceding complete year (immediately before this run in allYrs).
          if (i > 0) {
            const prev = compMap.get(allYrs[i - 1]);
            if (prev) seg.push({ x: prev.x, y: prev.y });
          }

          // All partial years in this contiguous run.
          while (i < allYrs.length && partMap.has(allYrs[i])) {
            const pe = partMap.get(allYrs[i]);
            seg.push({ x: pe.year, y: pe.estimate });
            i++;
          }

          // Following complete year (immediately after this run in allYrs).
          if (i < allYrs.length) {
            const next = compMap.get(allYrs[i]);
            if (next) seg.push({ x: next.x, y: next.y });
          }

          // Draw amber line for points within the visible x range.
          const segVis = seg.filter(p => p.x >= xMin && p.x <= xMax);
          if (segVis.length >= 2) {
            ctx.strokeStyle = colPartial; ctx.lineWidth = 1 * dpr; ctx.setLineDash([]);
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.beginPath();
            for (let k = 0; k < segVis.length; k++) {
              const px = toX(segVis[k].x), py = toY(segVis[k].y);
              if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
        }
      }
    }

    // Complete-year data line (drawn after amber connecting line so blue overlaps
    // amber at the shared complete-year junction points).
    if (pts) {
      ctx.strokeStyle = colLine; ctx.lineWidth = 1.5 * dpr;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      let open = false;
      ctx.beginPath();
      for (const p of pts) {
        if (!p) { if (open) { ctx.stroke(); ctx.beginPath(); open = false; } continue; }
        const px = toX(p.x), py = toY(p.y);
        if (!open) { ctx.moveTo(px, py); open = true; } else { ctx.lineTo(px, py); }
      }
      if (open) ctx.stroke();
    }

    // Partial-year estimate dots — only when CI is also on (Est.-only shows the line alone).
    if (this._showCI) {
      for (const pe of visiblePartials) {
        if (pe.estimate < yMin || pe.estimate > yMax) continue;
        const px = toX(pe.year);
        const py = toY(pe.estimate);
        const r  = this._hoveredPartial === pe ? 4 * dpr : 3 * dpr;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = colPartial; ctx.fill();
        ctx.strokeStyle = colBg; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
      }
    }

    // Intersection dot where inspector line meets the complete-year data line.
    if (this._hoveredPt && this._hoverX !== null &&
        this._hoverX >= xMin && this._hoverX <= xMax) {
      const px = toX(this._hoverX);
      const py = toY(this._hoveredPt.y);
      ctx.beginPath(); ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = colLine; ctx.fill();
      ctx.strokeStyle = colBg; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    }

    ctx.restore();

    if (isAnomaly && this._showAnomalyTrend && this._anomalyTrend) {
      const slope = this._anomalyTrend.slopePer100Years;
      const sign = slope < 0 ? '−' : '';
      const text = `${sign}${Math.abs(slope).toFixed(2)}°C/100yr`;
      ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
      const textW = ctx.measureText(text).width;
      const tx = ml + cw - textW - 6 * dpr;
      const ty = mt + 6 * dpr;
      ctx.fillStyle = colBg;
      ctx.fillRect(tx - 4 * dpr, ty - 2 * dpr, textW + 8 * dpr, 14 * dpr);
      ctx.fillStyle = colTrend;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(text, tx, ty);
    }

    // Axis border
    ctx.strokeStyle = colGrid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch); ctx.lineTo(ml + cw, mt + ch); ctx.stroke();
  }

  // ── Heatmap rendering ─────────────────────────────────────────────────────────

  _renderHeatmap(ctx, W, H, dpr, ml, mr, mt, mb, cw, ch) {
    const colText   = _cssVar('--text-muted') || '#5a6880';
    const colBorder = _cssVar('--border-color') || 'rgba(212,168,85,0.2)';
    const isLight   = document.documentElement.dataset.theme === 'light';

    const MISSING_DARK  = [230, 225, 215];
    const MISSING_LIGHT = [10,  15,  25];
    const missingStyle  = `rgb(${(isLight ? MISSING_LIGHT : MISSING_DARK).join(',')})`;

    if (this._xMin === null) {
      ctx.fillStyle = colText;
      ctx.font = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No temperature data available', W / 2, H / 2);
      return;
    }

    // Snap the unified domain to integer year boundaries for the heatmap grid.
    const startYear = Math.floor(this._xMin);
    const endYear   = Math.ceil(this._xMax);
    const numYears  = endYear - startYear;
    if (numYears < 1) return;

    const cellW = cw / numYears;
    const cellH = ch / 12;

    // Compute the temperature range of VISIBLE cells for the colour scale.
    let yMin = Infinity, yMax = -Infinity;
    for (let yr = startYear; yr < endYear; yr++) {
      const months = this._recordMap.get(yr);
      if (!months) continue;
      for (const v of months) {
        if (v == null) continue;
        const t = v / 100;
        if (t < yMin) yMin = t;
        if (t > yMax) yMax = t;
      }
    }

    if (!isFinite(yMin)) {
      ctx.fillStyle = colText;
      ctx.font = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No temperature data available', W / 2, H / 2);
      return;
    }

    const dataMid   = (yMin + yMax) / 2;
    const halfRange = Math.max(0.001, (yMax - yMin) / 2);

    if (this._coldLabel) this._coldLabel.textContent = yMin.toFixed(1) + '°C';
    if (this._hotLabel)  this._hotLabel.textContent  = yMax.toFixed(1) + '°C';

    ctx.save();
    ctx.beginPath(); ctx.rect(ml, mt, cw, ch); ctx.clip();

    for (let col = 0; col < numYears; col++) {
      const yr     = startYear + col;
      const cx     = ml + col * cellW;
      const months = this._recordMap.get(yr);

      for (let m = 0; m < 12; m++) {
        const cy = mt + m * cellH;
        const v  = months ? months[m] : null;

        if (v == null) {
          ctx.fillStyle = missingStyle;
        } else {
          const t   = Math.max(-1, Math.min(1, (v / 100 - dataMid) / halfRange));
          const rgb = _heatColor(t, isLight);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        }
        ctx.fillRect(cx, cy, cellW + 0.5, cellH + 0.5);
      }
    }

    // Inspector: box outline around the hovered cell.
    if (this._hoveredCell) {
      const { year, month } = this._hoveredCell;
      const col = year - startYear;
      if (col >= 0 && col < numYears) {
        const cx = ml + col * cellW;
        const cy = mt + month * cellH;
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.85)';
        ctx.lineWidth   = 2;
        ctx.strokeRect(cx + 1, cy + 1, cellW - 2, cellH - 2);
      }
    }

    ctx.restore();

    // Y-axis: month labels
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = colText;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let m = 0; m < 12; m++) {
      ctx.fillText(MONTHS[m], ml - 5 * dpr, mt + (m + 0.5) * cellH);
    }

    // X-axis: year labels
    const xStep  = _niceStep(numYears, 6);
    const xStart = Math.ceil(startYear / xStep) * xStep;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let yr = xStart; yr <= endYear; yr += xStep) {
      const px = ml + (yr - startYear) * cellW;
      if (px < ml - 0.5 || px > ml + cw + 0.5) continue;
      ctx.fillText(String(yr), px, mt + ch + 4 * dpr);
    }

    ctx.strokeStyle = colBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch); ctx.lineTo(ml + cw, mt + ch); ctx.stroke();
  }

  // ── Mouse event handlers ──────────────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button !== 0 || this._xMin === null) return;
    e.preventDefault();
    this._isDragging      = true;
    this._dragStartMouseX = e.clientX;
    this._dragStartXMin   = this._xMin;
    this._dragStartXMax   = this._xMax;
    this._canvas.style.cursor = 'grabbing';
    this._tooltip.hidden = true;
    this._hoverX         = null;
    this._hoveredPt      = null;
    this._hoveredPartial = null;
    this._hoveredCell    = null;
    this._scheduleRender();

    document.addEventListener('mousemove', this._docMouseMove);
    document.addEventListener('mouseup',   this._docMouseUp);
  }

  _onMouseMove(e) {
    if (this._isDragging) return;
    if (this._mode === 'heatmap') {
      this._hoverHeatmap(e);
    } else {
      this._hoverLine(e);
    }
  }

  _onMouseLeave() {
    if (!this._isDragging) {
      this._hoverX         = null;
      this._hoveredPt      = null;
      this._hoveredPartial = null;
      this._hoveredCell    = null;
      this._tooltip.hidden = true;
      this._scheduleRender();
    }
  }

  _doPan(e) {
    const geom = this._geom;
    if (!geom || this._xMin === null) return;

    const dx    = e.clientX - this._dragStartMouseX;
    const range = this._dragStartXMax - this._dragStartXMin;
    const shift = -dx / geom.cw * range;

    let newMin = this._dragStartXMin + shift;
    let newMax = this._dragStartXMax + shift;

    // Heatmap snaps to integer year boundaries.
    const isHeat = this._mode === 'heatmap';
    if (isHeat) {
      newMin = Math.floor(newMin);
      newMax = Math.ceil(newMax);
    }

    // Clamp to global boundaries while preserving span.
    const span = this._dragStartXMax - this._dragStartXMin;
    if (newMin < this._xMinPadded) { newMin = this._xMinPadded; newMax = newMin + span; }
    if (newMax > this._globalXMax) { newMax = this._globalXMax; newMin = newMax - span; }

    this._xMin = newMin;
    this._xMax = newMax;
    this._scheduleRender();
  }

  _hoverLine(e) {
    const pts = this._linePts();
    if (!pts || !this._geom || this._xMin === null) { this._tooltip.hidden = true; return; }

    const rect   = this._canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const { ml, mt, cw, ch } = this._geom;

    if (mouseX < ml || mouseX > ml + cw || mouseY < mt || mouseY > mt + ch) {
      if (this._hoverX !== null) {
        this._hoverX    = null;
        this._hoveredPt = null;
        this._tooltip.hidden = true;
        this._scheduleRender();
      }
      return;
    }

    const xHover = this._xMin + (mouseX - ml) / cw * (this._xMax - this._xMin);

    // Search complete-year points.
    let bestPt = null, bestPtDist = Infinity;
    if (pts) {
      for (const p of pts) {
        if (!p) continue;
        if (p.x < this._xMin || p.x > this._xMax) continue;
        const d = Math.abs(p.x - xHover);
        if (d < bestPtDist) { bestPtDist = d; bestPt = p; }
      }
    }

    // In yearly mode also search partial-year estimates (only when Est. is shown).
    let bestPe = null, bestPeDist = Infinity;
    if (this._mode === 'yearly' && this._showEst && this._partialEstimates) {
      for (const pe of this._partialEstimates) {
        if (pe.year < this._xMin || pe.year > this._xMax) continue;
        const d = Math.abs(pe.year - xHover);
        if (d < bestPeDist) { bestPeDist = d; bestPe = pe; }
      }
    }

    const usePartial = bestPe && bestPeDist < bestPtDist;
    const prevPt      = this._hoveredPt;
    const prevPartial = this._hoveredPartial;

    if (!bestPt && !bestPe) {
      this._hoverX         = xHover;
      this._hoveredPt      = null;
      this._hoveredPartial = null;
      this._tooltip.hidden = true;
      this._scheduleRender();
      return;
    }

    if (usePartial) {
      this._hoverX         = bestPe.year;
      this._hoveredPt      = null;
      this._hoveredPartial = bestPe;
      const abs  = Math.abs(bestPe.estimate);
      const sign = bestPe.estimate < 0 ? '−' : '';
      this._tooltip.textContent =
        `${bestPe.year} (${bestPe.nMonths} mo): ${sign}${abs.toFixed(2)}\u00b0C` +
        ` [${bestPe.ciLow.toFixed(2)}\u2013${bestPe.ciHigh.toFixed(2)}]`;
    } else {
      this._hoverX         = bestPt.x;
      this._hoveredPt      = bestPt;
      this._hoveredPartial = null;
      const abs  = Math.abs(bestPt.y);
      const sign = bestPt.y < 0 ? '−' : '';
      if (this._mode === 'anomaly') {
        const monthNote = bestPt.isFull ? '12 mo' : `${bestPt.nMonths} mo`;
        this._tooltip.textContent = `${bestPt.label} (${monthNote}): ${sign}${abs.toFixed(2)}\u00b0C anomaly`;
      } else {
        this._tooltip.textContent = `${bestPt.label}: ${sign}${abs.toFixed(2)}\u00b0C`;
      }
    }
    this._tooltip.hidden = false;

    const lineX = ml + (this._hoverX - this._xMin) / (this._xMax - this._xMin) * cw;
    const ttW   = this._tooltip.offsetWidth + 4;
    const left  = lineX + 14 + ttW > rect.width ? lineX - ttW - 8 : lineX + 14;
    const top   = Math.max(4, Math.min(mouseY - 18, rect.height - (this._tooltip.offsetHeight || 28) - 4));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    if (this._hoveredPt !== prevPt || this._hoveredPartial !== prevPartial) {
      this._scheduleRender();
      this._dispatchInspectorChange();
    }
  }

  _hoverHeatmap(e) {
    if (!this._geom || !this._recordMap.size || this._xMin === null) {
      this._tooltip.hidden = true; return;
    }

    const rect   = this._canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const { ml, mt, cw, ch } = this._geom;

    const xOff = mouseX - ml;
    const yOff = mouseY - mt;

    if (xOff < 0 || xOff >= cw || yOff < 0 || yOff >= ch) {
      if (this._hoveredCell) { this._hoveredCell = null; this._tooltip.hidden = true; this._scheduleRender(); }
      return;
    }

    const startYear = Math.floor(this._xMin);
    const numYears  = Math.ceil(this._xMax) - startYear;
    const year      = startYear + Math.floor(xOff / cw * numYears);
    const month     = Math.floor(yOff / ch * 12);

    const prev = this._hoveredCell;
    if (prev && prev.year === year && prev.month === month) return;

    const months = this._recordMap.get(year);
    const raw    = months ? months[month] : null;
    this._hoveredCell = { year, month, value: raw };

    if (raw != null) {
      const abs  = Math.abs(raw / 100);
      const sign = raw < 0 ? '−' : '';
      this._tooltip.textContent = `${MONTHS[month]} ${year}: ${sign}${abs.toFixed(2)}\u00b0C`;
    } else {
      this._tooltip.textContent = `${MONTHS[month]} ${year}: No data`;
    }
    this._tooltip.hidden = false;

    const ttW  = this._tooltip.offsetWidth + 4;
    const left = mouseX + 14 + ttW > rect.width ? mouseX - ttW - 8 : mouseX + 14;
    const top  = Math.max(4, Math.min(mouseY - 18, rect.height - 32));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    this._scheduleRender();
    this._dispatchInspectorChange();
  }
}
