/**
 * Temperature chart — canvas-based line plot for GHCNm monthly data.
 *
 * Usage:
 *   const chart = new TempChart(containerEl);
 *   chart.load(csvText);      // parse and render; empty/null = no data
 *   chart.setMode('yearly');  // 'monthly' | 'yearly'
 *   chart.resize();           // call when container becomes visible
 *   chart.destroy();          // cleanup on panel close
 */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Data parsing ───────────────────────────────────────────────────────────────

/**
 * Parse GHCNm CSV text (no header row).
 * Format: year, jan, feb, …, dec  — values in 0.01 °C integers, empty = missing.
 * Empty file or all-blank → returns [].
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
 * Each element is { x, y, label } or null (line break).
 * Nulls appear for missing months and gaps between non-adjacent years.
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
 * Each element is { x, y, label } or null (line break).
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

// ── Axis helpers ───────────────────────────────────────────────────────────────

/** Pick a tick step giving ~targetCount ticks across range. */
function _niceStep(range, targetCount) {
  if (range <= 0 || !isFinite(range)) return 1;
  const rough = range / targetCount;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const n     = rough / mag;
  const step  = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * mag;
}

// ── Theme helpers ──────────────────────────────────────────────────────────────

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── TempChart ─────────────────────────────────────────────────────────────────

export class TempChart {
  /** @param {HTMLElement} container - sized container (width × height via CSS) */
  constructor(container) {
    this._container = container;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'temp-chart-canvas';
    container.appendChild(this._canvas);

    this._tooltip = document.createElement('div');
    this._tooltip.className = 'chart-tooltip';
    this._tooltip.hidden = true;
    container.appendChild(this._tooltip);

    this._records  = null;
    this._monthly  = null;
    this._yearly   = null;
    this._mode     = 'monthly';
    this._xMin     = 1900;
    this._xMax     = 2025;
    this._dataXMin = 1900;
    this._dataXMax = 2025;
    this._dpr      = window.devicePixelRatio || 1;
    this._raf      = null;
    this._hovered  = null;
    // Last-rendered y range, needed for tooltip y-positioning.
    this._lastYMin = 0;
    this._lastYMax = 1;

    // Margins in CSS px (scaled by dpr inside _render).
    this._m = { l: 52, r: 16, t: 12, b: 36 };

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

  /** Load from CSV text. Empty string or null means no data available. */
  load(csvText) {
    const records = _parseCsv(csvText || '');
    this._records = records;

    if (records.length === 0) {
      this._monthly = null;
      this._yearly  = null;
      this._scheduleRender();
      return;
    }

    this._monthly = _monthlyPoints(records);
    this._yearly  = _yearlyPoints(records);

    const allX     = this._monthly.filter(Boolean).map(p => p.x);
    this._dataXMin = Math.min(...allX);
    this._dataXMax = Math.max(...allX);
    this._xMin     = this._dataXMin;
    this._xMax     = this._dataXMax;

    this.resize();
  }

  /** Switch between 'monthly' and 'yearly' view. */
  setMode(mode) {
    this._mode = mode;
    this._scheduleRender();
  }

  /** Recompute canvas size from container dimensions. Call when tab becomes visible. */
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

  /** Remove event listeners and stop rendering. */
  destroy() {
    this._ro.disconnect();
    this._canvas.removeEventListener('wheel', this._onWheel);
    this._canvas.removeEventListener('mousemove', this._onMouseMove);
    this._canvas.removeEventListener('mouseleave', this._onMouseLeave);
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _pts() {
    return this._mode === 'monthly' ? this._monthly : this._yearly;
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
  }

  _render() {
    const canvas = this._canvas;
    const ctx    = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return;

    const dpr = this._dpr;
    const { l, r, t, b } = this._m;
    const ml = l * dpr, mr = r * dpr, mt = t * dpr, mb = b * dpr;
    const cw = W - ml - mr;
    const ch = H - mt - mb;

    // Theme colours
    const colGrid  = _cssVar('--border-color') || 'rgba(212,168,85,0.2)';
    const colText  = _cssVar('--text-muted')   || '#5a6880';
    const colBg    = _cssVar('--bg-elevated')  || '#152c4a';
    const isLight  = document.documentElement.dataset.theme === 'light';
    const colLine  = isLight ? '#2060b0' : '#5090e0';
    const colZero  = isLight ? 'rgba(0,80,180,0.22)' : 'rgba(80,144,224,0.22)';

    ctx.clearRect(0, 0, W, H);

    const pts = this._pts();

    if (!pts) {
      ctx.fillStyle    = colText;
      ctx.font         = `${13 * dpr}px 'Source Sans 3', sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No temperature data available', W / 2, H / 2);
      return;
    }

    const xMin = this._xMin, xMax = this._xMax;

    // Y range from points visible in current x window
    const visible = pts.filter(p => p && p.x >= xMin && p.x <= xMax);
    if (visible.length < 1) {
      ctx.fillStyle    = colText;
      ctx.font         = `${12 * dpr}px 'JetBrains Mono', monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Zoom out to see data', W / 2, H / 2);
      return;
    }

    let yMin = Infinity, yMax = -Infinity;
    for (const p of visible) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
    const yPad = (yMax - yMin) * 0.1;
    yMin -= yPad; yMax += yPad;
    this._lastYMin = yMin; this._lastYMax = yMax;

    const toX = x => ml + (x - xMin) / (xMax - xMin) * cw;
    const toY = y => mt + (yMax - y) / (yMax - yMin) * ch;

    // ── Y grid + labels ──
    const yStep  = _niceStep(yMax - yMin, 5);
    const yStart = Math.ceil(yMin / yStep) * yStep;
    ctx.font         = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';

    for (let y = yStart; y < yMax + yStep * 0.01; y += yStep) {
      if (y < yMin - 1e-9) continue;
      const py = toY(y);

      ctx.strokeStyle = colGrid;
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(ml, py); ctx.lineTo(ml + cw, py); ctx.stroke();

      const dec = Math.max(0, -Math.floor(Math.log10(yStep)));
      ctx.fillStyle = colText;
      ctx.fillText(y.toFixed(dec) + '°', ml - 5 * dpr, py);
    }

    // ── X grid + labels ──
    const xStep  = _niceStep(xMax - xMin, 6);
    const xStart = Math.ceil(xMin / xStep) * xStep;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    for (let x = xStart; x <= xMax + xStep * 0.01; x += xStep) {
      const px = toX(x);
      if (px < ml - 0.5 || px > ml + cw + 0.5) continue;

      ctx.strokeStyle = colGrid;
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(px, mt); ctx.lineTo(px, mt + ch); ctx.stroke();

      ctx.fillStyle = colText;
      ctx.fillText(String(Math.round(x)), px, mt + ch + 5 * dpr);
    }

    // ── Dashed zero line ──
    if (yMin < 0 && yMax > 0) {
      const py0 = toY(0);
      ctx.strokeStyle = colZero;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(ml, py0); ctx.lineTo(ml + cw, py0); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Clipped drawing area ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(ml - 0.5, mt - 0.5, cw + 1, ch + 1);
    ctx.clip();

    // ── Temperature line (break at null) ──
    ctx.strokeStyle = colLine;
    ctx.lineWidth   = 1.5 * dpr;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    let open = false;
    ctx.beginPath();
    for (const p of pts) {
      if (!p) {
        if (open) { ctx.stroke(); ctx.beginPath(); open = false; }
        continue;
      }
      const px = toX(p.x), py = toY(p.y);
      if (!open) { ctx.moveTo(px, py); open = true; }
      else        { ctx.lineTo(px, py); }
    }
    if (open) ctx.stroke();

    // ── Hover dot ──
    if (this._hovered) {
      const px = toX(this._hovered.x), py = toY(this._hovered.y);
      ctx.beginPath();
      ctx.arc(px, py, 4.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = colLine;
      ctx.fill();
      ctx.strokeStyle = colBg;
      ctx.lineWidth   = 2 * dpr;
      ctx.stroke();
    }

    ctx.restore();

    // ── Axis border (left + bottom) ──
    ctx.strokeStyle = colGrid;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(ml, mt);
    ctx.lineTo(ml, mt + ch);
    ctx.lineTo(ml + cw, mt + ch);
    ctx.stroke();
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  _onWheel(e) {
    e.preventDefault();
    const rect   = this._canvas.getBoundingClientRect();
    const frac   = (e.clientX - rect.left) / rect.width;
    const pivot  = this._xMin + frac * (this._xMax - this._xMin);
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;

    let newMin = pivot - (pivot - this._xMin) * factor;
    let newMax = pivot + (this._xMax - pivot) * factor;

    // Clamp to data bounds
    newMin = Math.max(this._dataXMin, newMin);
    newMax = Math.min(this._dataXMax, newMax);
    if (newMax - newMin < 0.5) return; // refuse to zoom below ~6 months

    this._xMin = newMin;
    this._xMax = newMax;
    this._scheduleRender();
  }

  _onMouseMove(e) {
    const pts = this._pts();
    if (!pts) { this._tooltip.hidden = true; return; }

    const rect   = this._canvas.getBoundingClientRect();
    const frac   = (e.clientX - rect.left) / rect.width;
    const xHover = this._xMin + frac * (this._xMax - this._xMin);

    // Find the nearest non-null point by x distance
    let best = null, bestDist = Infinity;
    for (const p of pts) {
      if (!p) continue;
      const d = Math.abs(p.x - xHover);
      if (d < bestDist) { bestDist = d; best = p; }
    }

    if (!best) { this._hovered = null; this._tooltip.hidden = true; this._scheduleRender(); return; }

    this._hovered = best;

    // Format temperature (always show sign for clarity)
    const abs  = Math.abs(best.y);
    const sign = best.y < 0 ? '−' : '';
    this._tooltip.textContent = `${best.label}: ${sign}${abs.toFixed(2)}\u00b0C`;
    this._tooltip.hidden = false;

    // Position tooltip near cursor, flipping left if near right edge
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const ttW    = this._tooltip.offsetWidth + 4;
    const left   = mouseX + 14 + ttW > rect.width ? mouseX - ttW - 8 : mouseX + 14;
    const top    = Math.max(4, Math.min(mouseY - 18, rect.height - (this._tooltip.offsetHeight || 28) - 4));
    this._tooltip.style.left = left + 'px';
    this._tooltip.style.top  = top  + 'px';

    this._scheduleRender();
  }

  _onMouseLeave() {
    this._hovered = null;
    this._tooltip.hidden = true;
    this._scheduleRender();
  }
}
