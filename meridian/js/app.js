import { initMap, getMap, setProjection, updateMapTheme } from './map.js';
import { initTheme, getTheme, toggleTheme, onThemeChange } from './theme.js';
import { initMarkers, setMarkersTheme } from './markers.js';

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
  projectionBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setProjection(btn.dataset.projection);
      projectionBtns.forEach(b =>
        b.classList.toggle('active', b === btn)
      );
    });
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

  // ── Markers ────────────────────────────────────────────────────────
  initMarkers(getTheme()).catch(err => console.error('Markers load failed:', err));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
