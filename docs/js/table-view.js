/**
 * Phase 5 — Table View
 *
 * Public API:
 *   initTableView(locations)              — wire DOM; call once after index is loaded
 *   showTable({ sortColumn, sortDirection, syncUrl })
 *   hideTable()
 *   isTableVisible()  → boolean
 *   getCurrentTableHash()  → string       — e.g. 'table=name/asc'
 */

import { serialiseTableState, pushState } from './url-state.js?v=20260406';

const ROW_HEIGHT  = 44;
const BUFFER_ROWS = 10;

const COLUMNS = [
  { key: 'id',                          label: 'ID',           defaultDir: 'asc',  numeric: false },
  { key: 'name',                        label: 'Name',         defaultDir: 'asc',  numeric: false },
  { key: 'lat',                         label: 'Lat',          defaultDir: 'desc', numeric: true  },
  { key: 'lng',                         label: 'Lng',          defaultDir: 'asc',  numeric: true  },
  { key: 'elevation_m',                 label: 'Elev.',        defaultDir: 'desc', numeric: true  },
  { key: 'bu_2020_1km',                 label: 'BU 1km',       defaultDir: 'desc', numeric: true  },
  { key: 'bu_2020_5km',                 label: 'BU 5km',       defaultDir: 'desc', numeric: true  },
  { key: 'bu_2020_20km',               label: 'BU 20km',      defaultDir: 'desc', numeric: true  },
  { key: 'bu_change',                   label: 'BU Δ',         defaultDir: 'desc', numeric: true  },
  { key: 'pop_2020_1km',               label: 'Pop 1km',      defaultDir: 'desc', numeric: true  },
  { key: 'pop_2020_5km',               label: 'Pop 5km',      defaultDir: 'desc', numeric: true  },
  { key: 'pop_2020_20km',              label: 'Pop 20km',     defaultDir: 'desc', numeric: true  },
  { key: 'pop_change',                  label: 'Pop Δ',        defaultDir: 'desc', numeric: true  },
  { key: 'ghcn_first_year',            label: 'Start',        defaultDir: 'asc',  numeric: true  },
  { key: 'ghcn_last_year',             label: 'End',          defaultDir: 'desc', numeric: true  },
  { key: 'ghcn_longest_run_9_months',  label: 'Longest run',  defaultDir: 'desc', numeric: true  },
  { key: 'ghcn_qcu_slope_c_per_100yr', label: 'Unadj. trend', defaultDir: 'desc', numeric: true  },
  { key: 'ghcn_qcf_slope_c_per_100yr', label: 'Adj. trend',   defaultDir: 'desc', numeric: true  },
];

const COL_COUNT = COLUMNS.length; // all data columns; no separate action column

let _allLocations = [];
let _filtered     = [];
let _sortCol      = 'name';
let _sortDir      = 'asc';
let _filterText   = '';
let _filterTimer  = null;
let _visible      = false;

let _container = null;
let _scroller  = null;
let _tbody     = null;
let _countEl   = null;

// ── Public API ─────────────────────────────────────────────────────────────────

export function initTableView(locations) {
  _allLocations = locations;
  _container    = document.getElementById('table-container');
  _scroller     = document.getElementById('table-scroller');
  _tbody        = document.getElementById('table-tbody');
  _countEl      = document.getElementById('table-count');

  if (!_container) return;

  _container.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col    = th.dataset.col;
      const colDef = COLUMNS.find(c => c.key === col);
      if (_sortCol === col) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortCol = col;
        _sortDir = colDef?.defaultDir ?? 'asc';
      }
      _applyFilterAndSort();
      if (_scroller) _scroller.scrollTop = 0;
      _renderWindow();
      _updateHeaderArrows();
      pushState(serialiseTableState(_sortCol, _sortDir));
    });
  });

  _scroller?.addEventListener('scroll', _renderWindow, { passive: true });
}

export function showTable({ sortColumn, sortDirection, syncUrl = true } = {}) {
  if (sortColumn    !== undefined) _sortCol = sortColumn;
  if (sortDirection !== undefined) _sortDir = sortDirection;
  _visible = true;

  document.getElementById('map')?.style.setProperty('display', 'none');
  document.querySelector('.zoom-controls')?.style.setProperty('display', 'none');
  document.getElementById('map-qr-container')?.style.setProperty('display', 'none');

  if (_container) _container.hidden = false;

  document.querySelectorAll('.view-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === 'table')
  );

  _applyFilterAndSort();
  _renderWindow();
  _updateHeaderArrows();

  if (syncUrl) pushState(serialiseTableState(_sortCol, _sortDir));
  document.dispatchEvent(new CustomEvent('table:shown'));
}

export function hideTable() {
  _visible = false;

  document.getElementById('map')?.style.removeProperty('display');
  document.querySelector('.zoom-controls')?.style.removeProperty('display');
  document.getElementById('map-qr-container')?.style.removeProperty('display');

  if (_container) _container.hidden = true;

  document.querySelector('.view-btn[data-view="table"]')?.classList.remove('active');

  document.dispatchEvent(new CustomEvent('table:hidden'));
}

export function isTableVisible() {
  return _visible;
}

/**
 * Set a filter string from an external control (e.g. the header search).
 * Debounced by 150ms.
 */
export function setTableFilter(text) {
  clearTimeout(_filterTimer);
  _filterTimer = setTimeout(() => {
    _filterText = (text ?? '').trim();
    _applyFilterAndSort();
    if (_scroller) _scroller.scrollTop = 0;
    _renderWindow();
  }, 150);
}

export function getCurrentTableHash() {
  return serialiseTableState(_sortCol, _sortDir);
}

// ── Private ────────────────────────────────────────────────────────────────────

function _applyFilterAndSort() {
  const q = _filterText.toLowerCase();
  _filtered = q
    ? _allLocations.filter(loc =>
        (loc.id   ?? '').toLowerCase().includes(q) ||
        (loc.name ?? '').toLowerCase().includes(q)
      )
    : _allLocations.slice();

  const colDef = COLUMNS.find(c => c.key === _sortCol);
  _filtered.sort((a, b) => {
    const av  = a[_sortCol] ?? '';
    const bv  = b[_sortCol] ?? '';
    const cmp = colDef?.numeric
      ? (Number(av) || 0) - (Number(bv) || 0)
      : String(av).localeCompare(String(bv));
    return _sortDir === 'asc' ? cmp : -cmp;
  });

  _updateCount();
}

function _updateCount() {
  if (!_countEl) return;
  const total = _allLocations.length;
  const shown = _filtered.length;
  _countEl.textContent = shown === total
    ? `${total.toLocaleString()} stations`
    : `${shown.toLocaleString()} of ${total.toLocaleString()} stations`;
}

function _updateHeaderArrows() {
  _container?.querySelectorAll('th[data-col]').forEach(th => {
    const label = th.dataset.label;
    if (!label) return;
    if (th.dataset.col === _sortCol) {
      th.textContent = `${label} ${_sortDir === 'asc' ? '▲' : '▼'}`;
      th.classList.add('col-sorted');
      th.setAttribute('aria-sort', _sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.textContent = label;
      th.classList.remove('col-sorted');
      th.setAttribute('aria-sort', 'none');
    }
  });
}

function _renderWindow() {
  if (!_scroller || !_tbody) return;

  const scrollTop  = _scroller.scrollTop;
  const viewHeight = _scroller.clientHeight || 600;
  const total      = _filtered.length;

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  const visible    = Math.ceil(viewHeight / ROW_HEIGHT) + BUFFER_ROWS * 2;
  const endIndex   = Math.min(total, startIndex + visible);

  const topPad    = startIndex * ROW_HEIGHT;
  const bottomPad = Math.max(0, (total - endIndex) * ROW_HEIGHT);

  let html = `<tr class="row-spacer" style="height:${topPad}px"><td colspan="${COL_COUNT}" style="padding:0;border:none"></td></tr>`;
  for (let i = startIndex; i < endIndex; i++) {
    html += _renderRow(_filtered[i]);
  }
  html += `<tr class="row-spacer" style="height:${bottomPad}px"><td colspan="${COL_COUNT}" style="padding:0;border:none"></td></tr>`;

  _tbody.innerHTML = html;

  _tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.show-on-map-btn')) return;
      document.dispatchEvent(new CustomEvent('location:select', { detail: { id: row.dataset.id } }));
    });
    row.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.show-on-map-btn')) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('location:select', { detail: { id: row.dataset.id } }));
      }
    });
    row.querySelector('.show-on-map-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('table:show-on-map', {
        detail: {
          id:  row.dataset.id,
          lat: parseFloat(row.dataset.lat),
          lng: parseFloat(row.dataset.lng),
        },
      }));
    });
  });
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function _fmtBu(v)  { return v  != null ? `${v.toFixed(1)}%`  : '—'; }
function _fmtBuD(v) { return v  != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—'; }
function _fmtPop(v) { return v  != null ? v.toLocaleString()  : '—'; }
function _fmtPopD(v){ return v  != null ? `${v >= 0 ? '+' : ''}${v.toLocaleString()}` : '—'; }
function _fmtTrend(v) {
  if (v == null) return '—';
  const s = v >= 0 ? '+' : '−';
  return `${s}${Math.abs(v).toFixed(2)}°`;
}

function _renderRow(loc) {
  const latStr  = loc.lat  != null ? `${Math.abs(loc.lat).toFixed(2)}°${loc.lat  >= 0 ? 'N' : 'S'}` : '—';
  const lngStr  = loc.lng  != null ? `${Math.abs(loc.lng).toFixed(2)}°${loc.lng  >= 0 ? 'E' : 'W'}` : '—';
  const elevStr = loc.elevation_m != null ? `${Number(loc.elevation_m).toLocaleString()}m` : '—';

  // Trend sign colours applied via class
  const quClass = loc.ghcn_qcu_slope_c_per_100yr != null
    ? (loc.ghcn_qcu_slope_c_per_100yr > 0 ? ' trend-up' : loc.ghcn_qcu_slope_c_per_100yr < 0 ? ' trend-down' : '')
    : '';
  const qfClass = loc.ghcn_qcf_slope_c_per_100yr != null
    ? (loc.ghcn_qcf_slope_c_per_100yr > 0 ? ' trend-up' : loc.ghcn_qcf_slope_c_per_100yr < 0 ? ' trend-down' : '')
    : '';

  return `<tr data-id="${_esc(loc.id)}" data-lat="${_esc(String(loc.lat ?? ''))}" data-lng="${_esc(String(loc.lng ?? ''))}" class="station-row" tabindex="0">
    <td class="col-id">${_esc(loc.id ?? '')}</td>
    <td class="col-name-cell">
      <div class="col-name-flex">
        <span class="col-name-text">${_esc(loc.name ?? '')}</span>
        <button class="show-on-map-btn" title="Show on map" aria-label="Show ${_esc(loc.name ?? loc.id ?? '')} on map">⊕</button>
      </div>
    </td>
    <td class="col-numeric">${latStr}</td>
    <td class="col-numeric col-lng">${lngStr}</td>
    <td class="col-numeric">${elevStr}</td>
    <td class="col-numeric col-bu">${_fmtBu(loc.bu_2020_1km)}</td>
    <td class="col-numeric col-bu">${_fmtBu(loc.bu_2020_5km)}</td>
    <td class="col-numeric col-bu">${_fmtBu(loc.bu_2020_20km)}</td>
    <td class="col-numeric col-bu col-bu-change">${_fmtBuD(loc.bu_change)}</td>
    <td class="col-numeric col-pop">${_fmtPop(loc.pop_2020_1km)}</td>
    <td class="col-numeric col-pop">${_fmtPop(loc.pop_2020_5km)}</td>
    <td class="col-numeric col-pop">${_fmtPop(loc.pop_2020_20km)}</td>
    <td class="col-numeric col-pop col-pop-change">${_fmtPopD(loc.pop_change)}</td>
    <td class="col-numeric col-year">${loc.ghcn_first_year ?? '—'}</td>
    <td class="col-numeric col-year">${loc.ghcn_last_year  ?? '—'}</td>
    <td class="col-numeric col-run">${loc.ghcn_longest_run_9_months ?? '—'}</td>
    <td class="col-numeric col-trend${quClass}">${_fmtTrend(loc.ghcn_qcu_slope_c_per_100yr)}</td>
    <td class="col-numeric col-trend${qfClass}">${_fmtTrend(loc.ghcn_qcf_slope_c_per_100yr)}</td>
  </tr>`;
}

function _esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
