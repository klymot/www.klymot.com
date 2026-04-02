import { initMap, getMap, setProjection, getProjection, updateMapTheme, supportsProjection } from './map.js';
import { initTheme, getTheme, toggleTheme, onThemeChange } from './theme.js';
import { initMarkers, setMarkersTheme, getLocations } from './markers.js';
import { serialiseMapState, parseHash, pushState, onHashChange } from './url-state.js';
import { initMapQR } from './qr.js';
import { initDetailPanel, openDetail, setReturnMode } from './detail-panel.js';
import { initTableView, showTable, hideTable, isTableVisible, getCurrentTableHash, setTableFilter } from './table-view.js';
import { initSourcesPanel, toggleSources } from './sources-panel.js';

function init() {
  // Theme must be initialised first so data-theme is set before map style is chosen.
  initTheme();

  const map = initMap(getTheme());

  // ── Theme toggle ───────────────────────────────────────────────────
  document.getElementById('theme-toggle')
    ?.addEventListener('click', toggleTheme);

  onThemeChange((newTheme) => {
    setMarkersTheme(newTheme);
    updateMapTheme(newTheme);
  });

  // ── Unified view toggle (Mercator | Globe | Table) ─────────────────
  //
  // Mercator/Globe buttons switch to map view (if needed) and apply a
  // projection. The Table button switches to table view.

  const projectionSupported = supportsProjection();
  if (!projectionSupported) {
    document.querySelector('.view-btn[data-view="globe"]')
      ?.setAttribute('disabled', 'disabled');
  }

  function applyProjection(projection, { syncUrl = true } = {}) {
    const next = projectionSupported ? projection : 'mercator';
    setProjection(next);
    // Activate the matching view button; deactivate the others.
    document.querySelectorAll('.view-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.view === next)
    );
    if (syncUrl) {
      pushState(serialiseMapState(map, getProjection()));
      updateMapQR(window.location.href);
    }
  }

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'table') {
        showTable();
      } else {
        // Mercator or Globe: switch to map view first if needed.
        if (isTableVisible()) hideTable();
        applyProjection(view);
      }
    });
  });

  // When the table hides, resize the map and restore the map URL/QR.
  document.addEventListener('table:hidden', () => {
    map.resize();
    applyProjection(getProjection(), { syncUrl: true });
    updateMapQR(window.location.href);
  });

  // "Show on map" from a table row: hide table, fly to location.
  document.addEventListener('table:show-on-map', (e) => {
    const { lat, lng } = e.detail;
    hideTable(); // dispatches table:hidden → map.resize() + URL update
    map.flyTo({ center: [lng, lat], zoom: 8 });
  });

  // ── Zoom controls ──────────────────────────────────────────────────
  document.getElementById('zoom-in')
    ?.addEventListener('click', () => map.zoomIn());
  document.getElementById('zoom-out')
    ?.addEventListener('click', () => map.zoomOut());

  const zoomDisplay = document.getElementById('zoom-level');
  function updateZoom() {
    if (zoomDisplay) zoomDisplay.textContent = `${map.getZoom().toFixed(1)}×`;
  }
  map.on('zoom', updateZoom);
  map.on('load', updateZoom);

  // ── Coordinate display ─────────────────────────────────────────────
  const coordDisplay = document.getElementById('coord-display');
  map.on('mousemove', (e) => {
    if (!coordDisplay) return;
    const { lat, lng } = e.lngLat;
    const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
    const lngStr = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
    coordDisplay.textContent = `${latStr}, ${lngStr}`;
  });

  // ── Sources panel ─────────────────────────────────────────────────
  initSourcesPanel();
  document.getElementById('sources-btn')
    ?.addEventListener('click', toggleSources);

  // ── Detail panel ───────────────────────────────────────────────────
  initDetailPanel(() => serialiseMapState(map, getProjection()));

  document.addEventListener('location:select', (e) => {
    const mode    = isTableVisible() ? 'table' : 'map';
    const getHash = mode === 'table'
      ? getCurrentTableHash
      : () => serialiseMapState(map, getProjection());
    setReturnMode(mode, getHash);
    openDetail(e.detail.id);
  });

  document.addEventListener('detail:closed', (e) => {
    if (e.detail.returnTo === 'table') {
      showTable({ syncUrl: false });
    }
  });

  // ── URL state & QR ─────────────────────────────────────────────────
  const updateMapQR = initMapQR(window.location.href);

  // Station queued to open after flyTo settles (set by header search selection).
  let _pendingStation = null;

  let _moveendTimer = null;
  map.on('moveend', () => {
    clearTimeout(_moveendTimer);
    _moveendTimer = setTimeout(() => {
      if (isTableVisible()) return;
      pushState(serialiseMapState(map, getProjection()));
      updateMapQR(window.location.href);
      // Open any station that was queued by the search (flyTo has now settled).
      if (_pendingStation) {
        const id = _pendingStation;
        _pendingStation = null;
        document.dispatchEvent(new CustomEvent('location:select', { detail: { id } }));
      }
    }, 300);
  });

  const initialState = parseHash(window.location.hash);
  if (initialState?.type === 'map') {
    map.jumpTo({ center: [initialState.lng, initialState.lat], zoom: initialState.zoom });
    applyProjection(initialState.projection, { syncUrl: false });
  }

  onHashChange(() => {
    const state = parseHash(window.location.hash);
    if (!state) return;
    if (state.type === 'map') {
      if (isTableVisible()) hideTable();
      map.jumpTo({ center: [state.lng, state.lat], zoom: state.zoom });
      applyProjection(state.projection, { syncUrl: false });
    } else if (state.type === 'station') {
      _restoreStation(state.id);
    } else if (state.type === 'table') {
      showTable({ sortColumn: state.sortColumn, sortDirection: state.sortDirection, syncUrl: false });
    }
    if (!isTableVisible()) updateMapQR(window.location.href);
  });

  // ── Markers ────────────────────────────────────────────────────────
  initMarkers(getTheme()).then(() => {
    initTableView(getLocations());
    _initStationSearch(getLocations(), map, (id) => { _pendingStation = id; });

    if (initialState?.type === 'station') {
      _restoreStation(initialState.id);
    } else if (initialState?.type === 'table') {
      showTable({
        sortColumn:    initialState.sortColumn,
        sortDirection: initialState.sortDirection,
        syncUrl:       false,
      });
    }
  }).catch(err => console.error('Markers load failed:', err));

  function _restoreStation(id) {
    const locations = getLocations();
    const loc = locations.find(l => l.id === id);
    if (loc) {
      // Fly first; the moveend handler will open the detail panel once the
      // camera has settled. We fire location:select after a short delay so
      // the panel waits for the animation (same pattern as _selectStationOnMap).
      map.flyTo({ center: [loc.lng, loc.lat], zoom: 8 });
    }
    document.dispatchEvent(new CustomEvent('location:select', { detail: { id } }));
  }
}

// ── Station search (header autocomplete) ──────────────────────────────────────

function _initStationSearch(locations, map, queueStation) {
  const input    = document.getElementById('station-search-input');
  const dropdown = document.getElementById('station-dropdown');
  if (!input || !dropdown) return;

  function _esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();

    // In table view, always forward typing to the table filter (no dropdown needed).
    if (isTableVisible()) {
      setTableFilter(input.value.trim());
      dropdown.hidden = true;
      return;
    }

    if (!q) { dropdown.hidden = true; return; }

    const matches = locations.filter(loc =>
      (loc.id   ?? '').toLowerCase().includes(q) ||
      (loc.name ?? '').toLowerCase().includes(q)
    ).slice(0, 8);

    if (!matches.length) { dropdown.hidden = true; return; }

    dropdown.innerHTML = matches.map(loc => `
      <li class="station-option"
          data-id="${_esc(loc.id)}"
          data-lat="${loc.lat}"
          data-lng="${loc.lng}"
          role="option" tabindex="-1">
        <span class="option-label"><span class="option-id">${_esc(loc.id)}</span>: <span class="option-name">${_esc(loc.name ?? loc.id)}</span></span>
        <span class="option-country">${_esc(loc.country ?? '')}</span>
      </li>
    `).join('');

    dropdown.querySelectorAll('.station-option').forEach(li => {
      li.addEventListener('click', () => _selectStationOnMap(li));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') _selectStationOnMap(li);
      });
    });

    dropdown.hidden = false;
  });

  function _selectStationOnMap(li) {
    const id  = li.dataset.id;
    const lat = parseFloat(li.dataset.lat);
    const lng = parseFloat(li.dataset.lng);

    input.value     = '';
    dropdown.hidden = true;

    // Queue the station to open after moveend + 300ms debounce settle,
    // so the detail panel never appears while the map is still flying.
    queueStation(id);
    map.flyTo({ center: [lng, lat], zoom: 8 });
  }

  // When switching to table view, also wire current input value as filter.
  document.addEventListener('table:shown', () => {
    if (input.value.trim()) setTableFilter(input.value.trim());
  });

  // Close dropdown when clicking outside.
  document.addEventListener('click', (e) => {
    if (!document.getElementById('header-station-search')?.contains(e.target)) {
      dropdown.hidden = true;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.hidden = true;
      input.value = '';
      if (isTableVisible()) setTableFilter('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      dropdown.querySelector('.station-option')?.focus();
    }
  });

  // Arrow-key navigation within the dropdown.
  dropdown.addEventListener('keydown', (e) => {
    const items = [...dropdown.querySelectorAll('.station-option')];
    const idx   = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) { input.focus(); } else { items[idx - 1]?.focus(); }
    } else if (e.key === 'Escape') {
      dropdown.hidden = true;
      input.value = '';
      if (isTableVisible()) setTableFilter('');
      input.focus();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
