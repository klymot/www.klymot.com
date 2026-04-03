/**
 * Temperature chart — canvas-based line and heatmap plots for GHCNm data.
 *
 * Modes:
 *   'monthly'  — line chart, one point per month
 *   'yearly'   — line chart, one point per annual average
 *   'heatmap'  — calendar grid: year × month, cell colour = temperature
 *
 * All modes share a single x-axis domain (_xMin / _xMax in fractional years).
 * Switching modes preserves the current zoom range.  Heatmap rendering snaps
 * the domain to integer year boundaries for display.
 *
 * Usage:
 *   const chart = new TempChart(containerEl);
 *   chart.load(csvText);              // parse and render; empty/null = no data
 *   chart.setGlobalRange(min, max);   // set the shared x range from outside
 *   chart.setMode('heatmap');         // 'monthly' | 'yearly' | 'heatmap'
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
 * Years where every month is missing produce null; year gaps also produce null.
 */
function _yearlyPoints(records) {
  const pts = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (i > 0 && rec.year > records[i - 1].year + 1) pts.push(null);
    const valid = rec.months.filter(v => v != null);
    pts.push(valid.length > 0
      ? { x: rec.year, y: valid.reduce((s, v) => s + v, 0) / valid.length / 100, label: String(rec.year) }
      : null);
  }
  return pts;
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

    this._records    = null;
    this._monthly    = null;
    this._yearly     = null;
    this._recordMap  = new Map();   // year → months[]
    this._mode       = 'monthly';

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
    this._hoverX      = null;   // x in data space where the inspector line sits
    this._hoveredPt   = null;   // nearest data point to _hoverX (for tooltip)
    this._hoveredCell = null;   // heatmap hover { year, month, value }

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
      this._monthly   = null;
      this._yearly    = null;
      this._recordMap = new Map();
      this._scheduleRender();
      return;
    }

    this._monthly   = _monthlyPoints(records);
    this._yearly    = _yearlyPoints(records);
    this._recordMap = new Map(records.map(r => [r.year, r.months]));

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
    return this._mode === 'yearly' ? this._yearly : this._monthly;
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
    const colGrid  = _cssVar('--border-color') || 'rgba(212,168,85,0.2)';
    const colText  = _cssVar('--text-muted')   || '#5a6880';
    const colBg    = _cssVar('--bg-elevated')  || '#152c4a';
    const isLight  = document.documentElement.dataset.theme === 'light';
    const colLine  = isLight ? '#2060b0' : '#5090e0';
    const colZero  = isLight ? 'rgba(0,80,180,0.22)' : 'rgba(80,144,224,0.22)';
    const colInsp  = isLight ? 'rgba(0,80,180,0.45)' : 'rgba(80,144,224,0.5)';

    const pts  = this._linePts();
    const xMin = this._xMin, xMax = this._xMax;

    if (!pts || xMin === null) {
      ctx.fillStyle = colText;
      ctx.font = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No temperature data available', W / 2, H / 2);
      return;
    }

    const visible = pts.filter(p => p && p.x >= xMin && p.x <= xMax);
    if (visible.length < 1) {
      ctx.fillStyle = colText;
      ctx.font = `${12 * dpr}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Zoom out to see data', W / 2, H / 2);
      return;
    }

    let yMin = Infinity, yMax = -Infinity;
    for (const p of visible) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
    if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
    const yPad = (yMax - yMin) * 0.1;
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
      ctx.fillText(y.toFixed(dec) + '°', ml - 5 * dpr, py);
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

    // Data line.
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

    // Intersection dot where inspector line meets the data line.
    if (this._hoveredPt && this._hoverX !== null &&
        this._hoverX >= xMin && this._hoverX <= xMax) {
      const px = toX(this._hoverX);
      const py = toY(this._hoveredPt.y);
      ctx.beginPath(); ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = colLine; ctx.fill();
      ctx.strokeStyle = colBg; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    }

    ctx.restore();

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
      this._hoverX      = null;
      this._hoveredPt   = null;
      this._hoveredCell = null;
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

    let best = null, bestDist = Infinity;
    for (const p of pts) {
      if (!p) continue;
      if (p.x < this._xMin || p.x > this._xMax) continue;
      const d = Math.abs(p.x - xHover);
      if (d < bestDist) { bestDist = d; best = p; }
    }

    if (!best) {
      this._hoverX    = xHover;
      this._hoveredPt = null;
      this._tooltip.hidden = true;
      this._scheduleRender();
      return;
    }

    const changed = this._hoveredPt !== best;
    this._hoverX    = best.x;
    this._hoveredPt = best;

    const abs  = Math.abs(best.y);
    const sign = best.y < 0 ? '−' : '';
    this._tooltip.textContent = `${best.label}: ${sign}${abs.toFixed(2)}\u00b0C`;
    this._tooltip.hidden = false;

    const lineX = ml + (best.x - this._xMin) / (this._xMax - this._xMin) * cw;
    const ttW   = this._tooltip.offsetWidth + 4;
    const left  = lineX + 14 + ttW > rect.width ? lineX - ttW - 8 : lineX + 14;
    const top   = Math.max(4, Math.min(mouseY - 18, rect.height - (this._tooltip.offsetHeight || 28) - 4));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    if (changed) {
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
