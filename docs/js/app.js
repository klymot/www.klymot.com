import { initMap, getMap, setProjection, getProjection, updateMapTheme, supportsProjection } from './map.js?v=20260406';
import { initTheme, getTheme, toggleTheme, onThemeChange } from './theme.js?v=20260406';
import { initMarkers, setMarkersTheme, getLocations, getBuSprite, setFilteredLocations } from './markers.js?v=20260406';
import { serialiseMapState, parseHash, pushState, onHashChange, serialiseFilterState } from './url-state.js?v=20260406';
import { initMapQR } from './qr.js?v=20260406';
import { initDetailPanel, openDetail, closeDetail, setReturnMode, setRestoreState, preloadDetailSprites } from './detail-panel.js?v=20260406';
import { initTableView, showTable, hideTable, isTableVisible, getCurrentTableHash, setTableFilter, setColumnFilters } from './table-view.js?v=20260406';
import { initFilterBar, getActiveSelections, restoreSelections, clearAllFilters } from './filter-bar.js?v=20260406';
import { initAggregateView, showAggregateView, hideAggregateView, isAggregateVisible, refreshAggregateView, setFilterStateGetter, restoreGraphState, checkApiAvailable } from './aggregate-view.js?v=20260408';
import { initSourcesPanel, toggleSources } from './sources-panel.js?v=20260406';
import { initConsent } from './consent.js?v=20260406';
import { trackEvent } from './analytics.js?v=20260406';
import { initTour } from './tour.js?v=20260406';

function init() {
  // Theme must be initialised first so data-theme is set before map style is chosen.
  initTheme();
  initConsent();
  initTour();

  const map = initMap(getTheme());

  // ── Loading overlay & Table/Graph buttons: disabled until data is ready ──
  const _loadingOverlay = document.getElementById('loading-overlay');
  const _tableBtn       = document.querySelector('.view-btn[data-view="table"]');
  const _aggregateBtn   = document.querySelector('.view-btn[data-view="aggregate"]');
  if (_tableBtn)     _tableBtn.disabled     = true;
  if (_aggregateBtn) _aggregateBtn.disabled = true;

  // Start the API availability check concurrently with data loading.
  // A 3-second timeout is built into checkApiAvailable(); by the time markers
  // finish loading the result will almost always be ready.
  const _apiAvailablePromise = checkApiAvailable();

  // ── Header brand → reset to default view ──────────────────────────
  document.querySelector('.header-brand')
    ?.addEventListener('click', () => {
      // Close detail panel if open
      closeDetail();
      // Return to map view if table or aggregate view is visible
      if (isTableVisible()) hideTable();
      if (isAggregateVisible()) hideAggregateView();
      // Clear all filters
      clearAllFilters();
      // Fly back to the default globe position
      const _defaultProjection = supportsProjection() ? 'globe' : 'mercator';
      applyProjection(_defaultProjection, { syncUrl: false });
      map.flyTo({ center: [10, 20], zoom: 1.5 });
      trackEvent('header_brand_reset');
    });

  // ── Theme toggle ───────────────────────────────────────────────────
  document.getElementById('theme-toggle')
    ?.addEventListener('click', toggleTheme);

  const _themeAnnouncement = document.getElementById('theme-announcement');
  onThemeChange((newTheme) => {
    if (_themeAnnouncement) _themeAnnouncement.textContent = `Theme switched to ${newTheme} mode`;
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

  // Track current filtered IDs so the aggregate view can refresh when filters change.
  let _currentFilteredIds = null;

  function applyProjection(projection, { syncUrl = true } = {}) {
    if (isAggregateVisible()) hideAggregateView();
    const next = projectionSupported ? projection : 'mercator';
    setProjection(next);
    // Activate the matching view button; deactivate the others.
    document.querySelectorAll('.view-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.view === next)
    );
    if (syncUrl) {
      pushState(serialiseMapState(map, getProjection(), getActiveSelections()));
      updateMapQR(window.location.href);
    }
  }

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      const currentView = isAggregateVisible() ? 'aggregate'
                        : isTableVisible()      ? 'table'
                        :                         getProjection();
      if (view && view !== currentView) {
        trackEvent('view_mode_change', { from_view: currentView, to_view: view });
      }

      if (view === 'table') {
        if (isAggregateVisible()) hideAggregateView();
        showTable();
      } else if (view === 'aggregate') {
        if (isTableVisible()) hideTable();
        if (!isAggregateVisible()) {
          document.querySelectorAll('.view-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.view === 'aggregate')
          );
          const ids = _currentFilteredIds ? [..._currentFilteredIds] : getLocations().map(l => l.id);
          showAggregateView(ids);
        }
      } else {
        // Mercator or Globe: switch to map view first if needed.
        if (isTableVisible()) hideTable();
        applyProjection(view);
      }
    });
  });

  // When the table hides, resize the map and restore the map URL/QR.
  document.addEventListener('table:hidden', () => {
    if (isAggregateVisible()) return; // aggregate view took over, don't reset to map
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
  const locationBtn = document.getElementById('zoom-current-location');
  const locationTooltip = document.getElementById('zoom-current-location-tooltip');
  let locationTooltipTimer = null;
  let suppressLocationHoverTooltip = false;
  const defaultLocationMessage = 'Zoom to current location. Your location stays on this device.';
  let isLocationStatusVisible = false;

  function setLocationTooltipMessage(message) {
    if (locationTooltip) locationTooltip.textContent = message;
  }

  function positionLocationTooltip() {
    if (!locationTooltip || !locationBtn) return;
    const rect = locationBtn.getBoundingClientRect();
    const tooltipHeight = locationTooltip.offsetHeight || 48;
    const top = Math.min(rect.bottom + 8, window.innerHeight - tooltipHeight - 8);
    const right = Math.max(8, window.innerWidth - rect.right);
    locationTooltip.style.right = `${right}px`;
    locationTooltip.style.top = `${top}px`;
  }

  function showLocationTooltip(duration = null) {
    if (!locationTooltip) return;
    globalThis.clearTimeout(locationTooltipTimer);
    locationTooltip.hidden = false;
    positionLocationTooltip();
    if (duration != null) {
      locationTooltipTimer = globalThis.setTimeout(() => {
        locationTooltip.hidden = true;
      }, duration);
    }
  }

  function showLocationStatus(message, duration = 5000) {
    setLocationTooltipMessage(message);
    isLocationStatusVisible = true;
    showLocationTooltip(duration);
  }

  function hideLocationTooltip() {
    if (!locationTooltip) return;
    globalThis.clearTimeout(locationTooltipTimer);
    locationTooltip.hidden = true;
    isLocationStatusVisible = false;
    setLocationTooltipMessage(defaultLocationMessage);
  }

  locationBtn?.addEventListener('mouseenter', () => {
    if (suppressLocationHoverTooltip || isLocationStatusVisible) return;
    setLocationTooltipMessage(defaultLocationMessage);
    showLocationTooltip();
  });
  locationBtn?.addEventListener('mouseleave', () => {
    suppressLocationHoverTooltip = false;
    if (isLocationStatusVisible) return;
    hideLocationTooltip();
  });
  locationBtn?.addEventListener('focus', () => {
    if (isLocationStatusVisible) return;
    setLocationTooltipMessage(defaultLocationMessage);
    showLocationTooltip();
  });
  locationBtn?.addEventListener('blur', () => {
    if (isLocationStatusVisible) return;
    hideLocationTooltip();
  });
  locationBtn?.addEventListener('touchstart', () => {
    if (isLocationStatusVisible) return;
    setLocationTooltipMessage(defaultLocationMessage);
    showLocationTooltip(2500);
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (!locationTooltip?.hidden) positionLocationTooltip();
  });
  locationBtn?.addEventListener('click', () => {
    suppressLocationHoverTooltip = true;
    const geolocation = navigator.geolocation;
    if (!window.isSecureContext) {
      showLocationStatus('Location needs HTTPS on iPhone/Safari. Your location would stay on this device.');
      return;
    }

    if (!geolocation) {
      showLocationStatus('Location is not available in this browser.');
      return;
    }

    const doRequest = () => {
      locationBtn.disabled = true;
      showLocationStatus('Locating on this device only…', 15000);

      geolocation.getCurrentPosition(
        ({ coords }) => {
          if (isTableVisible()) hideTable();
          map.flyTo({
            center: [coords.longitude, coords.latitude],
            zoom: 12,
            essential: true,
          });
          locationBtn.disabled = false;
          showLocationStatus('Current location found. Your location stays on this device.', 2500);
        },
        (error) => {
          locationBtn.disabled = false;
          if (error?.code === 1) {
            showLocationStatus('Location denied. On iPhone, check Settings → Privacy → Location Services → Safari Websites.');
          } else if (error?.code === 2) {
            showLocationStatus('Current location is unavailable right now.');
          } else if (error?.code === 3) {
            showLocationStatus('Location request timed out. Try again.');
          } else {
            showLocationStatus('Could not get current location on this device.');
          }
        },
        {
          enableHighAccuracy: true,
          maximumAge: 300000,
          timeout: 15000,
        }
      );
    };

    // Pre-check permission state where the API is available (avoids a doomed
    // request and gives a more actionable message if already hard-denied).
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then(status => {
        if (status.state === 'denied') {
          showLocationStatus('Location denied. On iPhone, check Settings → Privacy → Location Services → Safari Websites.');
        } else {
          doRequest();
        }
      }).catch(() => doRequest()); // permissions API unsupported path
    } else {
      doRequest();
    }
  });

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
    const entry = getLocations().find(l => l.id === e.detail.id) ?? null;
    openDetail(e.detail.id, entry, getBuSprite());
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
      pushState(serialiseMapState(map, getProjection(), getActiveSelections()));
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
    if (state.filters) restoreSelections(state.filters);
    if (state.type === 'map') {
      if (isTableVisible()) hideTable();
      if (isAggregateVisible()) hideAggregateView();
      map.jumpTo({ center: [state.lng, state.lat], zoom: state.zoom });
      applyProjection(state.projection, { syncUrl: false });
    } else if (state.type === 'station') {
      _restoreStation(state.id, state);
    } else if (state.type === 'table') {
      if (isAggregateVisible()) hideAggregateView();
      showTable({ sortColumn: state.sortColumn, sortDirection: state.sortDirection, syncUrl: false });
    } else if (state.type === 'graph' && !_aggregateBtn?.hidden) {
      if (isTableVisible()) hideTable();
      if (!isAggregateVisible()) {
        document.querySelectorAll('.view-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.view === 'aggregate')
        );
      }
      const ids = _currentFilteredIds ? [..._currentFilteredIds] : getLocations().map(l => l.id);
      restoreGraphState(state, ids);
    }
    if (!isTableVisible() && !isAggregateVisible()) updateMapQR(window.location.href);
  });

  // ── Markers ────────────────────────────────────────────────────────
  initMarkers(getTheme()).then(async () => {
    // Data is ready: resolve the API check (usually already done) and
    // enable the aggregate button only if the API server is reachable.
    const _apiAvailable = await _apiAvailablePromise;

    if (_loadingOverlay) _loadingOverlay.classList.add('ready');
    if (_tableBtn)       _tableBtn.disabled = false;
    if (_aggregateBtn) {
      if (_apiAvailable) {
        _aggregateBtn.disabled = false;
      } else {
        _aggregateBtn.hidden = true;
      }
    }

    initAggregateView();
    setFilterStateGetter(getActiveSelections);

    const scheduleSpritePreload = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 1500 })
      : (fn) => window.setTimeout(fn, 300);
    scheduleSpritePreload(() => preloadDetailSprites(getBuSprite()));

    initTableView(getLocations(), () => serialiseFilterState(getActiveSelections()));
    initFilterBar(getLocations());
    _initStationSearch(getLocations(), map, (id) => { _pendingStation = id; });

    document.addEventListener('filter:change', (e) => {
      const { filteredIds } = e.detail;
      _currentFilteredIds = filteredIds;
      setColumnFilters(filteredIds);
      setFilteredLocations(filteredIds);
      if (isAggregateVisible()) {
        const ids = filteredIds ? [...filteredIds] : getLocations().map(l => l.id);
        refreshAggregateView(ids);
      }
      // Keep URL and QR code in sync with the active filter state
      if (isTableVisible()) {
        // table-view will push its own state via _pushTableState on next sort interaction;
        // for filter-only changes, push now
        const filterStr = serialiseFilterState(getActiveSelections());
        const base = getCurrentTableHash();
        pushState(filterStr ? `${base}/${filterStr}` : base);
        updateMapQR(window.location.href);
      } else if (!isAggregateVisible()) {
        pushState(serialiseMapState(map, getProjection(), getActiveSelections()));
        updateMapQR(window.location.href);
      }
      // When aggregate view is visible, it pushes its own URL state via _pushUrl().
    });

    // Restore any filter state embedded in the initial URL after the filter
    // consumers are listening, so the visible map/table state is updated too.
    if (initialState?.filters) restoreSelections(initialState.filters);

    if (initialState?.type === 'station') {
      _restoreStation(initialState.id, initialState);
    } else if (initialState?.type === 'table') {
      showTable({
        sortColumn:    initialState.sortColumn,
        sortDirection: initialState.sortDirection,
        syncUrl:       false,
      });
    } else if (initialState?.type === 'graph' && _apiAvailable) {
      document.querySelectorAll('.view-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === 'aggregate')
      );
      const ids = _currentFilteredIds ? [..._currentFilteredIds] : getLocations().map(l => l.id);
      restoreGraphState(initialState, ids);
    }
  }).catch(err => console.error('Markers load failed:', err));

  function _restoreStation(id, state = null) {
    // Store detail panel state so it can be applied when the panel opens.
    setRestoreState(state);
    const loc = getLocations().find(l => l.id === id);
    if (loc) {
      // Queue the station exactly like the header search does: let flyTo
      // settle first, then the moveend handler opens the panel and pushes
      // #station=… as the final URL (preventing the map hash from clobbering
      // the station hash on a subsequent reload).
      _pendingStation = id;
      map.flyTo({ center: [loc.lng, loc.lat], zoom: 8 });
    } else {
      document.dispatchEvent(new CustomEvent('location:select', { detail: { id } }));
    }
  }
}

// ── Station search (header autocomplete) ──────────────────────────────────────

function _initStationSearch(locations, map, queueStation) {
  const input    = document.getElementById('station-search-input');
  const dropdown = document.getElementById('station-dropdown');
  if (!input || !dropdown) return;

  let searchEventTimer = null;
  let lastTrackedSearch = '';

  function _esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  input.addEventListener('input', () => {
    const rawQuery = input.value.trim();
    const q = rawQuery.toLowerCase();

    clearTimeout(searchEventTimer);

    // In table view, always forward typing to the table filter (no dropdown needed).
    if (isTableVisible()) {
      setTableFilter(rawQuery);
      if (rawQuery) {
        const resultsCount = locations.filter(loc =>
          (loc.name    ?? '').toLowerCase().includes(q) ||
          (loc.country ?? '').toLowerCase().includes(q) ||
          (loc.network ?? '').toLowerCase().includes(q)
        ).length;
        searchEventTimer = setTimeout(() => {
          const searchKey = `table:${q}`;
          if (lastTrackedSearch === searchKey) return;
          lastTrackedSearch = searchKey;
          trackEvent('station_search', {
            search_context: 'table',
            query_length: rawQuery.length,
            results_count: resultsCount,
          });
        }, 400);
      } else {
        lastTrackedSearch = '';
      }
      dropdown.hidden = true;
      return;
    }

    if (!q) {
      dropdown.hidden = true;
      lastTrackedSearch = '';
      return;
    }

    const allMatches = locations.filter(loc =>
      (loc.id   ?? '').toLowerCase().includes(q) ||
      (loc.name ?? '').toLowerCase().includes(q)
    );
    const matches = allMatches.slice(0, 8);

    searchEventTimer = setTimeout(() => {
      const searchKey = `map:${q}`;
      if (lastTrackedSearch === searchKey) return;
      lastTrackedSearch = searchKey;
      trackEvent('station_search', {
        search_context: 'map',
        query_length: rawQuery.length,
        results_count: allMatches.length,
      });
    }, 400);

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
