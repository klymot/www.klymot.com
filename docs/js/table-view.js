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

import { serialiseTableState, pushState } from './url-state.js';

const ROW_HEIGHT  = 44;
const BUFFER_ROWS = 10;
const COL_COUNT   = 12; // 11 data columns + 1 action column

const COLUMNS = [
  { key: 'id',          label: 'ID',        defaultDir: 'asc',  numeric: false },
  { key: 'name',        label: 'Name',      defaultDir: 'asc',  numeric: false },
  { key: 'category',    label: 'Category',  defaultDir: 'asc',  numeric: false },
  { key: 'country',     label: 'Country',   defaultDir: 'asc',  numeric: false },
  { key: 'lat',         label: 'Latitude',  defaultDir: 'desc', numeric: true  },
  { key: 'lng',         label: 'Longitude', defaultDir: 'asc',  numeric: true  },
  { key: 'elevation_m', label: 'Elevation', defaultDir: 'desc', numeric: true  },
  { key: 'established', label: 'Est.',      defaultDir: 'asc',  numeric: true  },
  { key: 'network',     label: 'Network',   defaultDir: 'asc',  numeric: false },
  { key: 'bu_5km',      label: 'BU 5 km',  defaultDir: 'desc', numeric: true  },
  { key: 'bu_20km',     label: 'BU 20 km', defaultDir: 'desc', numeric: true  },
];

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

export function showTable({ sortColumn = 'name', sortDirection = 'asc', syncUrl = true } = {}) {
  _sortCol = sortColumn;
  _sortDir = sortDirection;
  _visible = true;

  document.getElementById('map')?.style.setProperty('display', 'none');
  document.querySelector('.zoom-controls')?.style.setProperty('display', 'none');
  document.getElementById('map-qr-container')?.style.setProperty('display', 'none');

  if (_container) _container.hidden = false;

  // Mark Table button active; clear Mercator/Globe active states.
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

  // Remove active from Table button; app.js will set the correct projection button.
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
        (loc.name    ?? '').toLowerCase().includes(q) ||
        (loc.country ?? '').toLowerCase().includes(q) ||
        (loc.network ?? '').toLowerCase().includes(q)
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

function _renderRow(loc) {
  const latStr  = loc.lat  != null ? `${Math.abs(loc.lat).toFixed(2)}°${loc.lat  >= 0 ? 'N' : 'S'}` : '—';
  const lngStr  = loc.lng  != null ? `${Math.abs(loc.lng).toFixed(2)}°${loc.lng  >= 0 ? 'E' : 'W'}` : '—';
  const elevStr = loc.elevation_m != null ? `${Number(loc.elevation_m).toLocaleString()}m` : '—';
  const cat     = _esc(loc.category ?? '');

  return `<tr data-id="${_esc(loc.id)}" data-lat="${_esc(String(loc.lat ?? ''))}" data-lng="${_esc(String(loc.lng ?? ''))}" class="station-row" tabindex="0">
    <td class="col-id">${_esc(loc.id ?? '')}</td>
    <td>${_esc(loc.name ?? '')}</td>
    <td><span class="category-badge cat-${cat}">${cat}</span></td>
    <td>${_esc(loc.country ?? '—')}</td>
    <td class="col-numeric">${latStr}</td>
    <td class="col-numeric col-lng">${lngStr}</td>
    <td class="col-numeric">${elevStr}</td>
    <td class="col-numeric">${_esc(String(loc.established ?? '—'))}</td>
    <td class="col-network">${_esc(loc.network ?? '—')}</td>
    <td class="col-numeric col-bu">${loc.bu_5km  != null ? `${loc.bu_5km.toFixed(1)}%`  : '—'}</td>
    <td class="col-numeric col-bu">${loc.bu_20km != null ? `${loc.bu_20km.toFixed(1)}%` : '—'}</td>
    <td class="col-action"><button class="show-on-map-btn" title="Show on map" aria-label="Show on map">⊕</button></td>
  </tr>`;
}

function _esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
