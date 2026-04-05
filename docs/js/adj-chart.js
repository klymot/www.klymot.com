/**
 * Adjustment chart — canvas-based line plot for GHCNm QCF − QCU differences.
 *
 * Modes:
 *   'monthly' — one point per month
 *   'yearly'  — annual mean of monthly diffs
 *
 * Usage:
 *   const chart = new AdjChart(containerEl);
 *   chart.load(qcuCsvText, qcfCsvText);   // parse, diff, render
 *   chart.setMode('monthly');              // 'monthly' | 'yearly'
 *   chart.setGlobalRange(min, max);        // set shared x range from outside
 *   chart.resize();                        // call when container becomes visible
 *   chart.destroy();                       // cleanup on panel close
 *
 * Events dispatched on the container element (bubbles):
 *   'chart:zoom' — fired after zoom or pan ends
 */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function _niceStep(range, targetCount) {
  if (range <= 0) return 1;
  const rough = range / targetCount;
  const exp   = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac  = rough / exp;
  return (frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10) * exp;
}

// ── Data parsing & computation ────────────────────────────────────────────────

/**
 * Parse GHCNm CSV text (no header row).
 * Format: year, jan..dec — values in 0.01°C integers, empty = missing.
 * Returns [{year, months: [12 values or null]}] sorted by year.
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
 * Build a map year → months[] for each dataset, then for every year in the
 * union compute diff[m] = qcf[m] - qcu[m] if both non-null, else null.
 * Filter out years where all months are null.
 * Return sorted array of {year, months}.
 */
function _diffRecords(qcuRecs, qcfRecs) {
  const qcuMap = new Map(qcuRecs.map(r => [r.year, r.months]));
  const qcfMap = new Map(qcfRecs.map(r => [r.year, r.months]));
  const years  = new Set([...qcuMap.keys(), ...qcfMap.keys()]);
  const result = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const qcu = qcuMap.get(year) ?? Array(12).fill(null);
    const qcf = qcfMap.get(year) ?? Array(12).fill(null);
    const months = [];
    for (let m = 0; m < 12; m++) {
      months.push(qcu[m] != null && qcf[m] != null ? qcf[m] - qcu[m] : null);
    }
    if (months.some(v => v != null)) result.push({ year, months });
  }
  return result;
}

/**
 * Build monthly point array from diff records.
 * Returns [{x: year + m/12, y: diff/100 °C, label: 'Mon YYYY'}|null, ...]
 * Inserts null between non-adjacent years (line break).
 */
function _monthlyPts(diffRecs) {
  const pts = [];
  let prevYear = null;
  for (const rec of diffRecs) {
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
 * Build yearly point array from diff records.
 * For each year, compute mean of non-null monthly diffs (in 0.01°C / 100 = °C).
 * Returns [{x: year, y: mean °C, nMonths: n}|null, ...]
 * Inserts null between non-adjacent years.
 * Only includes years with at least 1 valid month diff.
 */
function _yearlyPts(diffRecs) {
  const pts = [];
  let prevYear = null;
  for (const rec of diffRecs) {
    const valid = rec.months.filter(v => v != null);
    if (valid.length === 0) continue;
    if (prevYear !== null && rec.year > prevYear + 1) pts.push(null);
    const mean = valid.reduce((s, v) => s + v, 0) / valid.length / 100;
    pts.push({ x: rec.year, y: mean, nMonths: valid.length });
    prevYear = rec.year;
  }
  return pts;
}

/**
 * Compute y-axis range for adjustment data.
 * - Find min/max of non-null pts; if no data return {yMin: -0.1, yMax: 0.1}.
 * - Add 10% padding.
 * - ALWAYS include 0.
 * - Enforce minimum 0.2°C range (expand symmetrically centred on 0).
 */
function _adjYRange(pts) {
  const values = (pts ?? []).filter(Boolean).map(p => p.y);
  if (values.length === 0) return { yMin: -0.1, yMax: 0.1 };

  let yMin = Math.min(...values);
  let yMax = Math.max(...values);

  const pad = (yMax - yMin) * 0.1 || 0.01;
  yMin -= pad;
  yMax += pad;

  // Always include 0.
  if (yMin > 0) yMin = 0;
  if (yMax < 0) yMax = 0;

  // Enforce minimum 0.2°C range centred on 0.
  if (yMax - yMin < 0.2) {
    yMin = Math.min(yMin, -0.1);
    yMax = Math.max(yMax,  0.1);
  }

  return { yMin, yMax };
}

/**
 * Compute a least-squares trend line for point data.
 * @param {Array<{x: number, y: number}|null>} pts
 * @returns {{ slopePerYear: number, slopePer100Years: number, intercept: number }|null}
 */
function _adjTrendLine(pts) {
  const values = (pts ?? []).filter(Boolean);
  if (values.length < 2) return null;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const p of values) {
    sumX += p.x; sumY += p.y; sumXX += p.x * p.x; sumXY += p.x * p.y;
  }
  const n = values.length;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  const slopePerYear = (n * sumXY - sumX * sumY) / denom;
  const intercept    = (sumY - slopePerYear * sumX) / n;
  return { slopePerYear, slopePer100Years: slopePerYear * 100, intercept };
}

/** LOESS for adj chart (identical algorithm to temp-chart.js _loess). */
function _adjLoess(pts, span) {
  const valid = (pts ?? []).filter(Boolean);
  if (valid.length < 3) return null;
  const n = valid.length;
  const k = Math.max(3, Math.round(span * n));
  const result = [];
  for (let i = 0; i < n; i++) {
    const xi = valid[i].x;
    let lo = i, hi = i + 1, count = 1;
    while (count < k) {
      const dLo = lo > 0 ? xi - valid[lo - 1].x : Infinity;
      const dHi = hi < n ? valid[hi].x - xi      : Infinity;
      if (dLo <= dHi) { lo--; } else { hi++; }
      count++;
    }
    const h = Math.max(xi - valid[lo].x, valid[hi - 1].x - xi);
    if (h < 1e-12) { result.push({ x: xi, y: valid[i].y }); continue; }
    let W = 0, WX = 0, WY = 0, WXX = 0, WXY = 0;
    for (let j = lo; j < hi; j++) {
      const u = Math.abs(valid[j].x - xi) / h;
      if (u >= 1) continue;
      const w = Math.pow(1 - u * u * u, 3);
      const { x, y } = valid[j];
      W += w; WX += w * x; WY += w * y; WXX += w * x * x; WXY += w * x * y;
    }
    const det = W * WXX - WX * WX;
    let yFit;
    if (Math.abs(det) < 1e-12) { yFit = WY / W; }
    else {
      const slope = (W * WXY - WX * WY) / det;
      const intercept = (WY - slope * WX) / W;
      yFit = intercept + slope * xi;
    }
    result.push({ x: xi, y: yFit });
  }
  return result;
}

// ── AdjChart class ────────────────────────────────────────────────────────────

export class AdjChart {
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

    // Data state.
    this._diffRecs     = null;
    this._monthly      = null;
    this._yearly       = null;
    this._mode         = 'monthly';
    this._showTrend    = false;
    this._monthlyTrend = null;
    this._yearlyTrend  = null;
    this._showLoess     = false;
    this._loessSpan     = 0.3;
    this._loessMonthly  = null;
    this._loessYearly   = null;

    // X-axis domain (fractional years).
    this._xMin       = null;
    this._xMax       = null;
    this._xMinPadded = null;
    this._globalXMin = null;
    this._globalXMax = null;
    this._dataXMin   = null;
    this._dataXMax   = null;

    this._dpr = window.devicePixelRatio || 1;
    this._raf = null;

    // Hover / inspector state.
    this._hoverX    = null;
    this._hoveredPt = null;

    // Drag-to-pan state.
    this._isDragging      = false;
    this._dragStartMouseX = 0;
    this._dragStartXMin   = 0;
    this._dragStartXMax   = 0;

    // Geometry from last render (CSS px), used by mouse hit-testing.
    this._geom = null;

    // Margins in CSS px (same as TempChart line mode).
    this._M = { l: 52, r: 16, t: 12, b: 36 };

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

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Parse both CSVs, compute diffs, update data ranges, schedule render.
   * @param {string} qcuCsvText
   * @param {string} qcfCsvText
   */
  load(qcuCsvText, qcfCsvText) {
    const qcuRecs = _parseCsv(qcuCsvText || '');
    const qcfRecs = _parseCsv(qcfCsvText || '');

    if (qcuRecs.length === 0 && qcfRecs.length === 0) {
      this._diffRecs     = null;
      this._monthly      = null;
      this._yearly       = null;
      this._monthlyTrend = null;
      this._yearlyTrend  = null;
      this._loessMonthly = null;
      this._loessYearly  = null;
      this._scheduleRender();
      return;
    }

    const diffRecs     = _diffRecords(qcuRecs, qcfRecs);
    this._diffRecs     = diffRecs;
    this._monthly      = _monthlyPts(diffRecs);
    this._yearly       = _yearlyPts(diffRecs);
    this._monthlyTrend = _adjTrendLine(this._monthly);
    this._yearlyTrend  = _adjTrendLine(this._yearly);
    this._loessMonthly = _adjLoess(this._monthly, this._loessSpan);
    this._loessYearly  = _adjLoess(this._yearly,  this._loessSpan);

    const allX = this._monthly.filter(Boolean).map(p => p.x);
    if (allX.length > 0) {
      this._dataXMin = Math.min(...allX);
      this._dataXMax = Math.max(...allX);
      if (this._globalXMin === null) {
        this._initRangeFromData(this._dataXMin, this._dataXMax);
      }
    }

    this.resize();
  }

  /** Set display mode: 'monthly' or 'yearly'. Default: 'yearly'. */
  setMode(mode) {
    this._mode      = mode;
    this._hoverX    = null;
    this._hoveredPt = null;
    this._tooltip.hidden = true;
    this._scheduleRender();
  }

  /**
   * Set the initial x-domain from outside (e.g. cross-chart union range).
   * If x range not yet set, initialises it to this.
   * @param {number} min
   * @param {number} max
   */
  setGlobalRange(min, max) {
    this._initRangeFromData(min, max);
    this._scheduleRender();
  }

  /** @returns {{ min: number, max: number }|null} */
  getDataRange() {
    if (this._dataXMin === null) return null;
    return { min: this._dataXMin, max: this._dataXMax };
  }

  /**
   * Set x view range.
   * @param {number} min
   * @param {number} max
   */
  setZoom(min, max) {
    if (this._xMinPadded === null) return;
    this._xMin = Math.max(this._xMinPadded, min);
    this._xMax = Math.min(this._globalXMax, max);
    this._scheduleRender();
  }

  /** @returns {{ min: number, max: number }|null} */
  getZoom() {
    if (this._xMin === null) return null;
    return { min: this._xMin, max: this._xMax };
  }

  /** Show or hide the LOESS smooth line. */
  setShowLoess(v) { this._showLoess = !!v; this._scheduleRender(); }

  /** Set LOESS bandwidth span (0.1–0.9) and recompute. */
  setLoessSpan(span) {
    this._loessSpan    = Math.max(0.1, Math.min(0.9, span));
    if (this._monthly) {
      this._loessMonthly = _adjLoess(this._monthly, this._loessSpan);
      this._loessYearly  = _adjLoess(this._yearly,  this._loessSpan);
    }
    this._scheduleRender();
  }

  /** Show or hide the trend line. @param {boolean} v */
  setShowTrend(v) { this._showTrend = !!v; this._scheduleRender(); }

  /** Halve the x span centred on current view. */
  zoomIn()  { this._zoom(0.5); }

  /** Double the x span. */
  zoomOut() { this._zoom(2); }

  /** Restore to global range, dispatch zoom event. */
  resetZoom() {
    if (this._globalXMin === null) return;
    this._xMin = this._globalXMin;
    this._xMax = this._globalXMax;
    this._scheduleRender();
    this._dispatchZoomChange();
  }

  /** Update canvas size from container bounds. */
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

  /** Disconnect ResizeObserver, remove canvas/tooltip, remove doc listeners, cancel RAF. */
  destroy() {
    this._ro.disconnect();
    this._canvas.removeEventListener('mousedown',  this._onMouseDown);
    this._canvas.removeEventListener('mousemove',  this._onMouseMove);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    document.removeEventListener('mousemove', this._docMouseMove);
    document.removeEventListener('mouseup',   this._docMouseUp);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._canvas.remove();
    this._tooltip.remove();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

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

  _zoom(factor) {
    if (this._xMin === null) return;
    const mid  = (this._xMin + this._xMax) / 2;
    let newMin = mid - (mid - this._xMin) * factor;
    let newMax = mid + (this._xMax - mid) * factor;

    newMin = Math.max(this._xMinPadded, newMin);
    newMax = Math.min(this._globalXMax, newMax);

    if (newMax - newMin < 0.5) return;

    this._xMin = newMin;
    this._xMax = newMax;
    this._scheduleRender();
    this._dispatchZoomChange();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  _render() {
    const canvas = this._canvas;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;

    const dpr  = this._dpr;
    const rawM = this._M;
    const ml   = rawM.l * dpr, mr = rawM.r * dpr;
    const mt   = rawM.t * dpr, mb = rawM.b * dpr;
    const cw   = W - ml - mr;
    const ch   = H - mt - mb;

    // Store CSS-px geometry for mouse hit-testing.
    this._geom = { ml: rawM.l, mr: rawM.r, mt: rawM.t, mb: rawM.b,
                   cw: cw / dpr, ch: ch / dpr };

    ctx.clearRect(0, 0, W, H);

    const colGrid      = _cssVar('--border-color')   || 'rgba(212,168,85,0.2)';
    const colText      = _cssVar('--text-muted')     || '#5a6880';
    const colBg        = _cssVar('--bg-elevated')    || '#152c4a';
    const colBorderStr = _cssVar('--border-strong')  || '#4a6080';
    const isLight      = document.documentElement.dataset.theme === 'light';
    const colInsp      = isLight ? 'rgba(0,80,180,0.45)' : 'rgba(80,144,224,0.5)';
    let   colAdj       = _cssVar('--adj-total');
    if (!colAdj) colAdj = '#30c880';

    const pts  = this._mode === 'monthly' ? this._monthly : this._yearly;
    const xMin = this._xMin, xMax = this._xMax;

    if (!pts || pts.length === 0) {
      ctx.fillStyle = colText;
      ctx.font = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No adjustment data available', W / 2, H / 2);
      return;
    }

    if (xMin === null) return;

    const visible = pts.filter(p => p && p.x >= xMin && p.x <= xMax);
    if (visible.length === 0) {
      ctx.fillStyle = colText;
      ctx.font = `${12 * dpr}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Zoom out to see data', W / 2, H / 2);
      return;
    }

    const { yMin, yMax } = _adjYRange(visible);

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
      ctx.strokeStyle = colGrid; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ml, py); ctx.lineTo(ml + cw, py); ctx.stroke();
      const dec  = Math.max(0, -Math.floor(Math.log10(yStep)));
      const sign = y > 1e-9 ? '+' : '';
      ctx.fillStyle = colText;
      ctx.fillText(`${sign}${y.toFixed(dec)}°`, ml - 5 * dpr, py);
    }

    // X grid + labels
    const xStep  = _niceStep(xMax - xMin, 6);
    const xStart = Math.ceil(xMin / xStep) * xStep;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = xStart; x <= xMax + xStep * 0.01; x += xStep) {
      const px = toX(x);
      if (px < ml - 0.5 || px > ml + cw + 0.5) continue;
      ctx.strokeStyle = colGrid; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(px, mt); ctx.lineTo(px, mt + ch); ctx.stroke();
      ctx.fillStyle = colText;
      ctx.fillText(String(Math.round(x)), px, mt + ch + 5 * dpr);
    }

    // Zero baseline — thicker/brighter line using --border-strong.
    const py0 = toY(0);
    ctx.strokeStyle = colBorderStr; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(ml, py0); ctx.lineTo(ml + cw, py0); ctx.stroke();

    // Clip to chart area.
    ctx.save();
    ctx.beginPath(); ctx.rect(ml - 0.5, mt - 0.5, cw + 1, ch + 1); ctx.clip();

    // Inspector vertical line (drawn before data).
    if (this._hoverX !== null && this._hoverX >= xMin && this._hoverX <= xMax) {
      const px = toX(this._hoverX);
      ctx.strokeStyle = colInsp;
      ctx.lineWidth   = 1 * dpr;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(px, mt); ctx.lineTo(px, mt + ch); ctx.stroke();
    }

    // Data line — skip nulls (lift pen).
    ctx.strokeStyle = colAdj;
    ctx.lineWidth   = 1.5 * dpr;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.setLineDash([]);
    let open = false;
    ctx.beginPath();
    for (const p of pts) {
      if (!p) {
        if (open) { ctx.stroke(); ctx.beginPath(); open = false; }
        continue;
      }
      const px = toX(p.x), py = toY(p.y);
      if (!open) { ctx.moveTo(px, py); open = true; } else { ctx.lineTo(px, py); }
    }
    if (open) ctx.stroke();

    // Hover dot on nearest point.
    if (this._hoveredPt && this._hoverX !== null &&
        this._hoverX >= xMin && this._hoverX <= xMax) {
      const px = toX(this._hoverX);
      const py = toY(this._hoveredPt.y);
      ctx.beginPath(); ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = colAdj; ctx.fill();
      ctx.strokeStyle = colBg;  ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    }

    // Trend line (inside clip).
    const _activeTrend = this._mode === 'monthly' ? this._monthlyTrend : this._yearlyTrend;
    const colTrend     = isLight ? '#2060b0' : '#7fb2ff';

    // LOESS smooth line (bold, solid, 3 px — inside clip).
    const _activeLoess = this._mode === 'monthly' ? this._loessMonthly : this._loessYearly;
    if (_activeLoess && _activeLoess.length >= 2 && this._showLoess) {
      ctx.strokeStyle = colTrend;
      ctx.lineWidth   = 3 * dpr;
      ctx.setLineDash([]);
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.beginPath();
      let loessOpen = false;
      for (const p of _activeLoess) {
        if (p.x < xMin || p.x > xMax) { loessOpen = false; continue; }
        const px = toX(p.x), py = toY(p.y);
        if (!loessOpen) { ctx.moveTo(px, py); loessOpen = true; } else { ctx.lineTo(px, py); }
      }
      if (loessOpen) ctx.stroke();
    }

    if (_activeTrend && this._showTrend) {
      const trendStartY = _activeTrend.intercept + _activeTrend.slopePerYear * xMin;
      const trendEndY   = _activeTrend.intercept + _activeTrend.slopePerYear * xMax;
      ctx.strokeStyle = colTrend;
      ctx.lineWidth   = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(toX(xMin), toY(trendStartY));
      ctx.lineTo(toX(xMax), toY(trendEndY));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    // Slope label (outside clip).
    if (_activeTrend && this._showTrend) {
      const slope = _activeTrend.slopePer100Years;
      const sign  = slope < 0 ? '−' : '+';
      const text  = `${sign}${Math.abs(slope).toFixed(2)}°C/100yr`;
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

    // Axis border.
    ctx.strokeStyle = colGrid; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch); ctx.lineTo(ml + cw, mt + ch);
    ctx.stroke();
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
    this._hoverX    = null;
    this._hoveredPt = null;
    this._scheduleRender();

    document.addEventListener('mousemove', this._docMouseMove);
    document.addEventListener('mouseup',   this._docMouseUp);
  }

  _onMouseMove(e) {
    if (this._isDragging) return;
    this._hoverLine(e);
  }

  _onMouseLeave() {
    if (!this._isDragging) {
      this._hoverX    = null;
      this._hoveredPt = null;
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

    // Clamp to global boundaries while preserving span.
    const span = this._dragStartXMax - this._dragStartXMin;
    if (newMin < this._xMinPadded) { newMin = this._xMinPadded; newMax = newMin + span; }
    if (newMax > this._globalXMax) { newMax = this._globalXMax; newMin = newMax - span; }

    this._xMin = newMin;
    this._xMax = newMax;
    this._scheduleRender();
  }

  _hoverLine(e) {
    const pts = this._mode === 'monthly' ? this._monthly : this._yearly;
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

    // Find nearest point.
    let bestPt = null, bestDist = Infinity;
    for (const p of pts) {
      if (!p) continue;
      if (p.x < this._xMin || p.x > this._xMax) continue;
      const d = Math.abs(p.x - xHover);
      if (d < bestDist) { bestDist = d; bestPt = p; }
    }

    const prevPt = this._hoveredPt;

    if (!bestPt) {
      this._hoverX    = xHover;
      this._hoveredPt = null;
      this._tooltip.hidden = true;
      this._scheduleRender();
      return;
    }

    this._hoverX    = bestPt.x;
    this._hoveredPt = bestPt;

    // Format tooltip.
    const adj     = bestPt.y;
    const sign    = adj >= 0 ? '+' : '';
    const adjStr  = `${sign}${adj.toFixed(2)}°C`;

    if (this._mode === 'monthly') {
      this._tooltip.textContent = `${bestPt.label}  ${adjStr}`;
    } else {
      // yearly: show year + adjustment + month count
      const year = Math.round(bestPt.x);
      this._tooltip.textContent = `${year}\n${adjStr} (${bestPt.nMonths} mo)`;
    }
    this._tooltip.hidden = false;

    // Position tooltip: right of cursor, clamped to bounds.
    const lineX = ml + (this._hoverX - this._xMin) / (this._xMax - this._xMin) * cw;
    const ttW   = this._tooltip.offsetWidth + 4;
    const left  = lineX + 14 + ttW > rect.width ? lineX - ttW - 8 : lineX + 14;
    const top   = Math.max(4, Math.min(mouseY - 18,
                    rect.height - (this._tooltip.offsetHeight || 28) - 4));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    if (this._hoveredPt !== prevPt) {
      this._scheduleRender();
    }
  }
}
