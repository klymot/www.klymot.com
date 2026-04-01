import { initMap, getMap, setProjection, getProjection, updateMapTheme, supportsProjection } from './map.js';
import { initTheme, getTheme, toggleTheme, onThemeChange } from './theme.js';
import { initMarkers, setMarkersTheme, getLocations } from './markers.js';
import { serialiseMapState, parseHash, pushState, onHashChange } from './url-state.js';
import { initMapQR } from './qr.js';

function init() {
  // Theme must be initialised first so data-theme is set before map style is chosen.
  initTheme();

  const map = initMap(getTheme());

  // ── Theme toggle ───────────────────────────────────────────────────
  document.getElementById('theme-toggle')
    ?.addEventListener('click', toggleTheme);

  onThemeChange((newTheme) => {
    // Update markers theme variable before the style reload fires.
    setMarkersTheme(newTheme);
    updateMapTheme(newTheme);
  });

  // ── Projection toggle ──────────────────────────────────────────────
  const projectionBtns = document.querySelectorAll('.projection-btn');
  const projectionSupported = supportsProjection();

  if (!projectionSupported) {
    document.querySelector('[data-projection="globe"]')?.setAttribute('disabled', 'disabled');
  }

  function applyProjection(projection, { syncUrl = true } = {}) {
    const nextProjection = projectionSupported ? projection : 'mercator';
    setProjection(nextProjection);
    projectionBtns.forEach(btn =>
      btn.classList.toggle('active', btn.dataset.projection === nextProjection)
    );
    if (syncUrl) {
      pushState(serialiseMapState(map, getProjection()));
      updateMapQR(window.location.href);
    }
  }

  projectionBtns.forEach(btn => {
    btn.addEventListener('click', () => applyProjection(btn.dataset.projection));
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

  // ── URL state & QR ─────────────────────────────────────────────────
  const updateMapQR = initMapQR(window.location.href);

  // Debounced moveend: update URL hash + QR after pan/zoom settles.
  let _moveendTimer = null;
  map.on('moveend', () => {
    clearTimeout(_moveendTimer);
    _moveendTimer = setTimeout(() => {
      pushState(serialiseMapState(map, getProjection()));
      updateMapQR(window.location.href);
    }, 300);
  });

  // Parse the initial URL hash and restore viewport / selection.
  const initialState = parseHash(window.location.hash);
  if (initialState?.type === 'map') {
    map.jumpTo({ center: [initialState.lng, initialState.lat], zoom: initialState.zoom });
    applyProjection(initialState.projection, { syncUrl: false });
  }

  // Respond to browser back/forward navigation.
  onHashChange(() => {
    const state = parseHash(window.location.hash);
    if (!state) return;
    if (state.type === 'map') {
      map.jumpTo({ center: [state.lng, state.lat], zoom: state.zoom });
      applyProjection(state.projection, { syncUrl: false });
    } else if (state.type === 'station') {
      _restoreStation(state.id);
    }
    updateMapQR(window.location.href);
  });

  // ── Markers ────────────────────────────────────────────────────────
  initMarkers(getTheme()).then(() => {
    // If the page loaded with a station hash, restore it now that the index
    // is available (coordinates required to fly the map there).
    if (initialState?.type === 'station') {
      _restoreStation(initialState.id);
    }
  }).catch(err => console.error('Markers load failed:', err));

  // Fly the map to a station and dispatch location:select so Phase 4's detail
  // panel can open. Defined as a hoisted function declaration so it can be
  // referenced in the .then() callback above before its textual position.
  function _restoreStation(id) {
    const locations = getLocations();
    const loc = locations.find(l => l.id === id);
    if (loc) {
      map.flyTo({ center: [loc.lng, loc.lat], zoom: 8 });
    }
    document.dispatchEvent(new CustomEvent('location:select', { detail: { id } }));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
