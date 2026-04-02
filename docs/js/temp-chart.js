/**
 * Temperature chart — canvas-based line and heatmap plots for GHCNm data.
 *
 * Modes:
 *   'monthly'  — line chart, one point per month
 *   'yearly'   — line chart, one point per annual average
 *   'heatmap'  — calendar grid: year × month, cell colour = temperature
 *
 * Usage:
 *   const chart = new TempChart(containerEl);
 *   chart.load(csvText);      // parse and render; empty/null = no data
 *   chart.setMode('heatmap'); // 'monthly' | 'yearly' | 'heatmap'
 *   chart.resize();           // call when container becomes visible
 *   chart.destroy();          // cleanup on panel close
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
 * Missing data uses the inverse of the mid colour.
 */
function _heatColor(t, isLight) {
  const clamp = x => Math.max(0, Math.min(255, Math.round(x)));
  // Cold and hot anchors are the same for both themes.
  const COLD = [10,  50, 220];
  const HOT  = [220, 25,  10];
  // Mid matches the panel background so near-average temps blend in.
  // Dark mode: near-black (#0a1018).  Light mode: near-white (#f4f0e8).
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

    // Separate x ranges so line and heatmap zoom independently.
    this._lineXMin = 1900;  this._lineXMax = 2025;
    this._heatXMin = 1900;  this._heatXMax = 2025;
    this._heatXMinPadded = 1900;  // minimum allowed heatXMin (respects 50-yr snap)

    this._dataXMin = 1900;  this._dataXMax = 2025;
    this._dpr      = window.devicePixelRatio || 1;
    this._raf      = null;

    // Hover state
    this._hoveredPt   = null;   // line chart hover
    this._hoveredCell = null;   // heatmap hover { year, month, value }

    // Geometry from last render (CSS px), used by hover handlers.
    this._geom = null;

    // Margins in CSS px — different for each mode.
    this._LINE_M = { l: 52, r: 16, t: 12, b: 36 };
    this._HEAT_M = { l: 44, r: 16, t:  8, b: 28 };

    this._onWheel      = this._onWheel.bind(this);
    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);

    this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this._canvas.addEventListener('mousemove', this._onMouseMove);
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

    // Line chart: full data range.
    this._lineXMin = this._dataXMin;
    this._lineXMax = this._dataXMax;

    // Heatmap: snap left boundary to a multiple of 50 when span < 100 years.
    const span = this._dataXMax - this._dataXMin;
    this._heatXMinPadded = span < 100
      ? Math.floor(this._dataXMin / 50) * 50
      : Math.floor(this._dataXMin);
    this._heatXMin = this._heatXMinPadded;
    this._heatXMax = Math.ceil(this._dataXMax);

    this.resize();
  }

  setMode(mode) {
    const prev = this._mode;
    this._mode = mode;

    // Clear hover state on mode change.
    this._hoveredPt   = null;
    this._hoveredCell = null;
    this._tooltip.hidden = true;

    // Toggle heatmap height class on the container.
    this._container.classList.toggle('heatmap', mode === 'heatmap');

    // Show / hide HTML legend.
    if (this._heatLegend) this._heatLegend.hidden = mode !== 'heatmap';

    // Height change triggers ResizeObserver → resize() automatically.
    // Force an immediate resize+render in case no size change fires.
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
    this._canvas.removeEventListener('wheel', this._onWheel);
    this._canvas.removeEventListener('mousemove', this._onMouseMove);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  _linePts() {
    return this._mode === 'yearly' ? this._yearly : this._monthly;
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
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

    const pts  = this._linePts();
    const xMin = this._lineXMin, xMax = this._lineXMax;

    if (!pts) {
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

    // Clip and draw line
    ctx.save();
    ctx.beginPath(); ctx.rect(ml - 0.5, mt - 0.5, cw + 1, ch + 1); ctx.clip();

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

    // Hover dot
    if (this._hoveredPt) {
      const px = toX(this._hoveredPt.x), py = toY(this._hoveredPt.y);
      ctx.beginPath(); ctx.arc(px, py, 4.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = colLine; ctx.fill();
      ctx.strokeStyle = colBg; ctx.lineWidth = 2 * dpr; ctx.stroke();
    }

    ctx.restore();

    // Axis border
    ctx.strokeStyle = colGrid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch); ctx.lineTo(ml + cw, mt + ch); ctx.stroke();
  }

  // ── Heatmap rendering ─────────────────────────────────────────────────────────

  _renderHeatmap(ctx, W, H, dpr, ml, mr, mt, mb, cw, ch) {
    const colText  = _cssVar('--text-muted') || '#5a6880';
    const colBorder = _cssVar('--border-color') || 'rgba(212,168,85,0.2)';
    const isLight  = document.documentElement.dataset.theme === 'light';

    // Missing data colour: inverse of the gradient midpoint (white in dark, dark in light).
    const MISSING_DARK  = [230, 225, 215];  // near-white on a dark panel
    const MISSING_LIGHT = [10,  15,  25];   // near-black on a light panel
    const missingRGB    = isLight ? MISSING_LIGHT : MISSING_DARK;
    const missingStyle  = `rgb(${missingRGB.join(',')})`;

    const xMin = this._heatXMin, xMax = this._heatXMax;
    const startYear = Math.floor(xMin);
    const endYear   = Math.ceil(xMax);
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

    // Update HTML legend labels.
    if (this._coldLabel) this._coldLabel.textContent = yMin.toFixed(1) + '°C';
    if (this._hotLabel)  this._hotLabel.textContent  = yMax.toFixed(1) + '°C';

    // ── Draw cells ──
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
        // +0.5 closes sub-pixel gaps between cells.
        ctx.fillRect(cx, cy, cellW + 0.5, cellH + 0.5);
      }
    }

    // Hovered cell highlight.
    if (this._hoveredCell) {
      const { year, month } = this._hoveredCell;
      const col = year - startYear;
      if (col >= 0 && col < numYears) {
        const cx = ml + col * cellW;
        const cy = mt + month * cellH;
        ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.75)';
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(cx + 0.75, cy + 0.75, cellW - 1.5, cellH - 1.5);
      }
    }

    ctx.restore();

    // ── Y-axis: month labels ──
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = colText;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let m = 0; m < 12; m++) {
      ctx.fillText(MONTHS[m], ml - 5 * dpr, mt + (m + 0.5) * cellH);
    }

    // ── X-axis: year labels ──
    const xStep  = _niceStep(numYears, 6);
    const xStart = Math.ceil(startYear / xStep) * xStep;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let yr = xStart; yr <= endYear; yr += xStep) {
      const px = ml + (yr - startYear) * cellW;
      if (px < ml - 0.5 || px > ml + cw + 0.5) continue;
      ctx.fillText(String(yr), px, mt + ch + 4 * dpr);
    }

    // ── Axis border ──
    ctx.strokeStyle = colBorder; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ml, mt); ctx.lineTo(ml, mt + ch); ctx.lineTo(ml + cw, mt + ch); ctx.stroke();
  }

  // ── Mouse / wheel event handlers ──────────────────────────────────────────────

  _onWheel(e) {
    e.preventDefault();
    const isHeat = this._mode === 'heatmap';
    const xMinK  = isHeat ? '_heatXMin' : '_lineXMin';
    const xMaxK  = isHeat ? '_heatXMax' : '_lineXMax';

    const rect   = this._canvas.getBoundingClientRect();
    const frac   = (e.clientX - rect.left) / rect.width;
    const pivot  = this[xMinK] + frac * (this[xMaxK] - this[xMinK]);
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;

    let newMin = pivot - (pivot - this[xMinK]) * factor;
    let newMax = pivot + (this[xMaxK] - pivot) * factor;

    if (isHeat) {
      // Snap to integer year boundaries.
      newMin = Math.floor(newMin);
      newMax = Math.ceil(newMax);
      newMin = Math.max(this._heatXMinPadded, newMin);
      newMax = Math.min(Math.ceil(this._dataXMax), newMax);
      if (newMax - newMin < 5) return;   // keep at least 5 year columns
    } else {
      newMin = Math.max(this._dataXMin, newMin);
      newMax = Math.min(this._dataXMax, newMax);
      if (newMax - newMin < 0.5) return; // keep at least ~6 months
    }

    this[xMinK] = newMin;
    this[xMaxK] = newMax;
    this._scheduleRender();
  }

  _onMouseMove(e) {
    if (this._mode === 'heatmap') {
      this._hoverHeatmap(e);
    } else {
      this._hoverLine(e);
    }
  }

  _onMouseLeave() {
    this._hoveredPt   = null;
    this._hoveredCell = null;
    this._tooltip.hidden = true;
    this._scheduleRender();
  }

  _hoverLine(e) {
    const pts = this._linePts();
    if (!pts) { this._tooltip.hidden = true; return; }

    const rect   = this._canvas.getBoundingClientRect();
    const frac   = (e.clientX - rect.left) / rect.width;
    const xHover = this._lineXMin + frac * (this._lineXMax - this._lineXMin);

    let best = null, bestDist = Infinity;
    for (const p of pts) {
      if (!p) continue;
      const d = Math.abs(p.x - xHover);
      if (d < bestDist) { bestDist = d; best = p; }
    }

    if (!best) { this._hoveredPt = null; this._tooltip.hidden = true; this._scheduleRender(); return; }

    this._hoveredPt = best;
    const abs  = Math.abs(best.y);
    const sign = best.y < 0 ? '−' : '';
    this._tooltip.textContent = `${best.label}: ${sign}${abs.toFixed(2)}\u00b0C`;
    this._tooltip.hidden = false;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const ttW    = this._tooltip.offsetWidth + 4;
    const left   = mouseX + 14 + ttW > rect.width ? mouseX - ttW - 8 : mouseX + 14;
    const top    = Math.max(4, Math.min(mouseY - 18, rect.height - (this._tooltip.offsetHeight || 28) - 4));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    this._scheduleRender();
  }

  _hoverHeatmap(e) {
    if (!this._geom || !this._recordMap.size) {
      this._tooltip.hidden = true; return;
    }

    const rect   = this._canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const { ml, mt, cw, ch } = this._geom; // CSS px

    const xOff = mouseX - ml;
    const yOff = mouseY - mt;

    if (xOff < 0 || xOff >= cw || yOff < 0 || yOff >= ch) {
      if (this._hoveredCell) { this._hoveredCell = null; this._tooltip.hidden = true; this._scheduleRender(); }
      return;
    }

    const numYears = Math.ceil(this._heatXMax) - Math.floor(this._heatXMin);
    const year     = Math.floor(this._heatXMin) + Math.floor(xOff / cw * numYears);
    const month    = Math.floor(yOff / ch * 12);

    // Only re-render if cell changed.
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
  }
}
