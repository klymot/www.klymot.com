/**
 * Filter Bar — column-based filters for the station table and map
 *
 * Public API:
 *   initFilterBar(locations)       — build the filter bar from location data
 *   toggleFilterBar()              — show/hide the filter bar (preserves selections)
 *   clearAllFilters()              — reset all active selections
 *
 * Events dispatched on document:
 *   filter:change  { detail: { filteredIds: Set<string>|null } }
 *     null  = no active filters (show everything)
 *     Set   = only show locations whose id is in this set
 */

// ── Latitude bands (geographic zones) ─────────────────────────────────────────

const LAT_BANDS = [
  { label: 'Arctic (>66.5°N)',             minVal:  66.5, maxVal:  Infinity },
  { label: 'N. Temperate (23.4–66.5°N)',   minVal:  23.4, maxVal:  66.5    },
  { label: 'Tropics (23.4°S–23.4°N)',      minVal: -23.4, maxVal:  23.4    },
  { label: 'S. Temperate (23.4–66.5°S)',   minVal: -66.5, maxVal: -23.4    },
  { label: 'Antarctic (<66.5°S)',          minVal: -Infinity, maxVal: -66.5 },
];

// ── Longitude bands (~3-hour UTC zones, 45° each) ─────────────────────────────

const LNG_BANDS = [
  { label: 'UTC−12 to UTC−9',  minVal: -180, maxVal: -135 },
  { label: 'UTC−9 to UTC−6',   minVal: -135, maxVal:  -90 },
  { label: 'UTC−6 to UTC−3',   minVal:  -90, maxVal:  -45 },
  { label: 'UTC−3 to UTC+0',   minVal:  -45, maxVal:    0 },
  { label: 'UTC+0 to UTC+3',   minVal:    0, maxVal:   45 },
  { label: 'UTC+3 to UTC+6',   minVal:   45, maxVal:   90 },
  { label: 'UTC+6 to UTC+9',   minVal:   90, maxVal:  135 },
  { label: 'UTC+9 to UTC+12',  minVal:  135, maxVal:  Infinity },
];

// ── Elevation bands (metres) ───────────────────────────────────────────────────

const ELEV_BANDS = [
  { label: 'Below sea level (<0 m)',    minVal: -Infinity, maxVal:     0 },
  { label: 'Low (0–500 m)',             minVal:        0,  maxVal:   500 },
  { label: 'Moderate (500–1 500 m)',    minVal:      500,  maxVal:  1500 },
  { label: 'High (1 500–3 000 m)',      minVal:     1500,  maxVal:  3000 },
  { label: 'Very High (3 000–5 000 m)', minVal:     3000,  maxVal:  5000 },
  { label: 'Extreme (>5 000 m)',        minVal:     5000,  maxVal:  Infinity },
];

// ── Longest-run bands (years, in 50-year windows) ─────────────────────────────

const RUN_BANDS = [
  { label: '<50 yr',       minVal:   0, maxVal:  50 },
  { label: '50–100 yr',    minVal:  50, maxVal: 100 },
  { label: '100–150 yr',   minVal: 100, maxVal: 150 },
  { label: '150–200 yr',   minVal: 150, maxVal: 200 },
  { label: '200–250 yr',   minVal: 200, maxVal: 250 },
  { label: '250–300 yr',   minVal: 250, maxVal: 300 },
  { label: '>300 yr',      minVal: 300, maxVal: Infinity },
];

// ── Percentile band templates (resolved against actual data thresholds) ────────

const PCT_TEMPLATES = [
  { label: '>99th %ile',    pLow: 99, pHigh: 100 },
  { label: '95–99th %ile',  pLow: 95, pHigh:  99 },
  { label: '90–95th %ile',  pLow: 90, pHigh:  95 },
  { label: '75–90th %ile',  pLow: 75, pHigh:  90 },
  { label: '25–75th %ile',  pLow: 25, pHigh:  75 },
  { label: '10–25th %ile',  pLow: 10, pHigh:  25 },
  { label: '5–10th %ile',   pLow:  5, pHigh:  10 },
  { label: '1–5th %ile',    pLow:  1, pHigh:   5 },
  { label: '<1st %ile',     pLow:  0, pHigh:   1 },
];

// ── Filter definitions (in bar order) ─────────────────────────────────────────

const FILTER_META = [
  { id: 'lat',                          label: 'Latitude',   field: 'lat',                          type: 'range',      bands: LAT_BANDS  },
  { id: 'lng',                          label: 'Longitude',  field: 'lng',                          type: 'range',      bands: LNG_BANDS  },
  { id: 'elevation_m',                  label: 'Elevation',  field: 'elevation_m',                  type: 'range',      bands: ELEV_BANDS },
  { id: 'ghcn_longest_run_9_months',    label: 'Longest Run', field: 'ghcn_longest_run_9_months',  type: 'range',      bands: RUN_BANDS  },
  { id: 'bu_2020_1km',                  label: 'BU 1km',     field: 'bu_2020_1km',                  type: 'percentile' },
  { id: 'bu_2020_5km',                  label: 'BU 5km',     field: 'bu_2020_5km',                  type: 'percentile' },
  { id: 'bu_2020_20km',                 label: 'BU 20km',    field: 'bu_2020_20km',                 type: 'percentile' },
  { id: 'pop_2020_1km',                 label: 'Pop 1km',    field: 'pop_2020_1km',                 type: 'percentile' },
  { id: 'pop_2020_5km',                 label: 'Pop 5km',    field: 'pop_2020_5km',                 type: 'percentile' },
  { id: 'pop_2020_20km',                label: 'Pop 20km',   field: 'pop_2020_20km',                type: 'percentile' },
];

// ── Module state ───────────────────────────────────────────────────────────────

let _locations     = [];
let _filterDefs    = []; // resolved FILTER_META with bands containing actual minVal/maxVal
let _active        = {}; // { filterId → Set<number> } — selected band indices
let _barVisible    = false;
let _openId        = null;  // id of the currently-open dropdown
let _dropdownEl    = null;  // live dropdown DOM node (appended to body)
let _barEl         = null;
let _clearBtn      = null;

// ── Public API ─────────────────────────────────────────────────────────────────

export function initFilterBar(locations) {
  _locations = locations;
  _filterDefs = FILTER_META.map(meta => ({
    ...meta,
    bands: meta.type === 'percentile'
      ? _computePercentileBands(locations, meta.field)
      : meta.bands,
  }));

  _barEl = document.getElementById('filter-bar');
  if (!_barEl) return;

  _buildBarDOM();
  _wireToggleButton();

  // Close open dropdown on outside click
  document.addEventListener('click', _handleOutsideClick);
  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _openId) _closeDropdown();
  });
}

export function toggleFilterBar() {
  _barVisible = !_barVisible;
  if (_barEl) _barEl.hidden = !_barVisible;

  const toggleBtn = document.getElementById('filter-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', _barVisible);
    toggleBtn.setAttribute('aria-pressed', String(_barVisible));
  }

  // When bar is hidden, remove all filtering; when re-opened, reapply
  _dispatchFilterChange();
}

export function clearAllFilters() {
  _active = {};
  _refreshAllButtons();
  _updateClearButton();
  _dispatchFilterChange();
}

/**
 * Return a snapshot of the active filter selections (only when the bar is
 * visible and at least one band is selected — otherwise returns {}).
 * Suitable for passing to serialiseFilterState().
 */
export function getActiveSelections() {
  if (!_barVisible) return {};
  const copy = {};
  for (const [k, v] of Object.entries(_active)) {
    if (v instanceof Set && v.size > 0) copy[k] = new Set(v);
  }
  return copy;
}

/**
 * Restore filter state from a parsed URL hash (e.g. state.filters).
 * Silently ignored if filter-bar has not been initialised yet.
 * @param {Object} selections  — { filterId: Set<number> }
 */
export function restoreSelections(selections) {
  if (!_barEl) return; // not yet initialised
  _active = {};
  if (selections && typeof selections === 'object') {
    for (const [k, v] of Object.entries(selections)) {
      if (v instanceof Set && v.size > 0) _active[k] = new Set(v);
    }
  }
  const hasAny = Object.keys(_active).length > 0;
  if (hasAny && !_barVisible) {
    _barVisible = true;
    _barEl.hidden = false;
    const toggleBtn = document.getElementById('filter-toggle');
    if (toggleBtn) {
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('aria-pressed', 'true');
    }
  }
  _refreshAllButtons();
  _updateClearButton();
  _dispatchFilterChange();
}

// ── Private: DOM builders ──────────────────────────────────────────────────────

function _buildBarDOM() {
  _barEl.innerHTML = '';
  _barEl.setAttribute('role', 'toolbar');
  _barEl.setAttribute('aria-label', 'Column filters');

  for (const def of _filterDefs) {
    if (!def.bands.length) continue;
    const btn = document.createElement('button');
    btn.className = 'btn-control filter-bar-btn';
    btn.dataset.filterId = def.id;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = def.label + ' ▾';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_openId === def.id) {
        _closeDropdown();
      } else {
        _openDropdown(def.id, btn);
      }
    });
    _barEl.appendChild(btn);
  }

  // Spacer
  const spacer = document.createElement('span');
  spacer.className = 'filter-bar-spacer';
  _barEl.appendChild(spacer);

  // Clear all button
  _clearBtn = document.createElement('button');
  _clearBtn.className = 'btn-control filter-bar-clear';
  _clearBtn.id = 'filter-clear-btn';
  _clearBtn.textContent = 'Clear all';
  _clearBtn.hidden = true;
  _clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearAllFilters();
  });
  _barEl.appendChild(_clearBtn);
}

function _wireToggleButton() {
  const btn = document.getElementById('filter-toggle');
  if (btn) {
    btn.addEventListener('click', () => toggleFilterBar());
  }
}

// ── Private: Dropdown ──────────────────────────────────────────────────────────

function _openDropdown(filterId, anchorBtn) {
  _closeDropdown();
  _openId = filterId;

  const def = _filterDefs.find(d => d.id === filterId);
  if (!def) return;

  anchorBtn.setAttribute('aria-expanded', 'true');

  const selection = _active[filterId] ?? new Set();

  const el = document.createElement('div');
  el.className = 'filter-dropdown';
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-multiselectable', 'true');
  el.setAttribute('aria-label', `${def.label} filter options`);
  el.dataset.filterId = filterId;

  def.bands.forEach((band, idx) => {
    const checked = selection.has(idx);
    const item = document.createElement('label');
    item.className = 'filter-dropdown-item' + (checked ? ' selected' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(checked));

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.dataset.bandIdx = idx;

    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (!_active[filterId]) _active[filterId] = new Set();
      if (cb.checked) {
        _active[filterId].add(idx);
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      } else {
        _active[filterId].delete(idx);
        if (_active[filterId].size === 0) delete _active[filterId];
        item.classList.remove('selected');
        item.setAttribute('aria-selected', 'false');
      }
      _refreshButton(filterId);
      _updateClearButton();
      _dispatchFilterChange();
    });

    const span = document.createElement('span');
    span.textContent = band.label;

    item.appendChild(cb);
    item.appendChild(span);
    el.appendChild(item);
  });

  // Position below the anchor button
  const rect = anchorBtn.getBoundingClientRect();
  el.style.position = 'fixed';
  el.style.top = `${rect.bottom + 4}px`;
  el.style.left = `${rect.left}px`;
  el.style.zIndex = '200';

  document.body.appendChild(el);
  _dropdownEl = el;

  // Keep dropdown inside viewport horizontally
  requestAnimationFrame(() => {
    if (!_dropdownEl) return;
    const dr = _dropdownEl.getBoundingClientRect();
    if (dr.right > window.innerWidth - 8) {
      _dropdownEl.style.left = `${window.innerWidth - dr.width - 8}px`;
    }
  });
}

function _closeDropdown() {
  if (_openId) {
    const btn = _barEl?.querySelector(`.filter-bar-btn[data-filter-id="${_openId}"]`);
    btn?.setAttribute('aria-expanded', 'false');
  }
  _dropdownEl?.remove();
  _dropdownEl = null;
  _openId = null;
}

function _handleOutsideClick(e) {
  if (_openId && _dropdownEl && !_dropdownEl.contains(e.target)) {
    const triggerBtn = _barEl?.querySelector(`.filter-bar-btn[data-filter-id="${_openId}"]`);
    if (!triggerBtn?.contains(e.target)) {
      _closeDropdown();
    }
  }
}

// ── Private: UI refresh ────────────────────────────────────────────────────────

function _refreshButton(filterId) {
  const btn = _barEl?.querySelector(`.filter-bar-btn[data-filter-id="${filterId}"]`);
  if (!btn) return;
  const def = _filterDefs.find(d => d.id === filterId);
  const count = (_active[filterId] ?? new Set()).size;
  const label = def?.label ?? filterId;
  btn.textContent = count > 0 ? `${label} (${count}) ▾` : `${label} ▾`;
  btn.classList.toggle('active', count > 0);
}

function _refreshAllButtons() {
  for (const def of _filterDefs) {
    _refreshButton(def.id);
  }
}

function _updateClearButton() {
  if (!_clearBtn) return;
  const hasAny = Object.values(_active).some(s => s.size > 0);
  _clearBtn.hidden = !hasAny;
}

// ── Private: Filtering ─────────────────────────────────────────────────────────

function _dispatchFilterChange() {
  const hasActive = _barVisible && Object.values(_active).some(s => s.size > 0);
  if (!hasActive) {
    document.dispatchEvent(new CustomEvent('filter:change', { detail: { filteredIds: null } }));
    return;
  }

  const filteredIds = new Set(
    _locations.filter(_matchesAllFilters).map(l => l.id)
  );
  document.dispatchEvent(new CustomEvent('filter:change', { detail: { filteredIds } }));
}

function _matchesAllFilters(loc) {
  for (const [filterId, selection] of Object.entries(_active)) {
    if (!selection.size) continue;
    const def = _filterDefs.find(d => d.id === filterId);
    if (!def) continue;
    // Station must match at least one selected band (OR within filter)
    const value = loc[def.field];
    if (value == null || isNaN(Number(value))) return false;
    const v = Number(value);
    const matches = [...selection].some(idx => {
      const band = def.bands[idx];
      if (!band) return false;
      const lo = band.minVal === -Infinity ? true : v >= band.minVal;
      const hi = band.maxVal ===  Infinity ? true : v <= band.maxVal;
      return lo && hi;
    });
    if (!matches) return false;
  }
  return true;
}

// ── Private: Percentile thresholds ────────────────────────────────────────────

function _computePercentileBands(locations, field) {
  const values = locations
    .map(l => l[field])
    .filter(v => v != null && !isNaN(Number(v)))
    .map(Number)
    .sort((a, b) => a - b);

  if (values.length < 4) return []; // not enough data to compute percentiles

  const n = values.length;
  const pct = (p) => {
    if (p <= 0)   return values[0];
    if (p >= 100) return values[n - 1];
    const idx = Math.floor((p / 100) * n);
    return values[Math.min(idx, n - 1)];
  };

  return PCT_TEMPLATES.map(tmpl => ({
    label:   tmpl.label,
    minVal:  tmpl.pLow  === 0   ? -Infinity : pct(tmpl.pLow),
    maxVal:  tmpl.pHigh === 100 ?  Infinity : pct(tmpl.pHigh),
  }));
}
