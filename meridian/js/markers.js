import { getMap } from './map.js';

// ── Module state ─────────────────────────────────────────────────────────────
let _locations       = [];
let _featureCollection = null;
let _currentTheme    = 'dark';
let _styleLoaded     = false;

// ── Colour palette ───────────────────────────────────────────────────────────
const COLORS = {
  dark: {
    observatory:  '#5ca8c4',
    station:      '#d4a855',
    textFill:     '#e8d5a3',
    textHalo:     'rgba(10,22,40,0.8)',
  },
  light: {
    observatory:  '#1e6e90',
    station:      '#7a5f20',
    textFill:     '#3d2b1f',
    textHalo:     'rgba(244,240,232,0.8)',
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Return the loaded location array (consumed by table-view, detail-panel, etc.). */
export function getLocations() {
  return _locations;
}

/**
 * Fetch index.json, add clustered GeoJSON source + 4 layers, wire click events.
 * Must be called after initMap().
 */
export async function initMarkers(theme) {
  _currentTheme = theme;
  const map = getMap();

  // Re-add source+layers every time the map style is (re-)loaded.
  // Covers both initial load and theme-driven style swaps.
  map.on('style.load', () => {
    _styleLoaded = true;
    if (_featureCollection) _addLayers();
  });

  const resp = await fetch('data/index.json');
  const { locations } = await resp.json();
  _locations = locations;
  _featureCollection = _toGeoJSON(locations);
  _updateStationCount();

  // If style.load already fired before the fetch finished, add layers now.
  if (_styleLoaded) _addLayers();

  // ── Event wiring (done once; survives style reloads) ───────────────────────

  // Cluster click → zoom in to expand
  map.on('click', 'clusters', (e) => {
    const features = e.features ?? [];
    if (!features.length) return;
    const feature   = features[0];
    const clusterId = feature.properties.cluster_id;
    map.getSource('locations').getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({ center: feature.geometry.coordinates, zoom });
    });
  });

  // Unclustered marker click → dispatch event for detail panel (Phase 4)
  map.on('click', 'location-markers', (e) => {
    const features = e.features ?? [];
    if (!features.length) return;
    document.dispatchEvent(new CustomEvent('location:select', {
      detail: { id: features[0].properties.id },
    }));
  });

  // Pointer cursor on interactive layers
  for (const layer of ['clusters', 'location-markers']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

/**
 * Call this before updateMapTheme() so the next style.load uses the new colours.
 */
export function setMarkersTheme(theme) {
  _currentTheme = theme;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function _toGeoJSON(locations) {
  return {
    type: 'FeatureCollection',
    features: locations.map(loc => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
      properties: { id: loc.id, name: loc.name, category: loc.category },
    })),
  };
}

function _addLayers() {
  const map    = getMap();
  const colors = COLORS[_currentTheme] ?? COLORS.dark;

  map.addSource('locations', {
    type:           'geojson',
    data:           _featureCollection,
    cluster:        true,
    clusterRadius:  50,
    clusterMaxZoom: 10,
  });

  // ── Cluster circles ──────────────────────────────────────────────────
  map.addLayer({
    id:     'clusters',
    type:   'circle',
    source: 'locations',
    filter: ['has', 'point_count'],
    paint:  {
      'circle-color': [
        'step', ['get', 'point_count'],
        colors.station, 10,
        '#e09030',      50,
        '#c07020',
      ],
      'circle-radius': [
        'step', ['get', 'point_count'],
        14, 10,
        20, 50,
        26,
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(255,255,255,0.25)',
    },
  });

  // Cluster count labels
  map.addLayer({
    id:     'cluster-count',
    type:   'symbol',
    source: 'locations',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font':  ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
      'text-size':  12,
    },
    paint: { 'text-color': '#ffffff' },
  });

  // ── Unclustered markers ──────────────────────────────────────────────
  map.addLayer({
    id:     'location-markers',
    type:   'circle',
    source: 'locations',
    filter: ['!', ['has', 'point_count']],
    paint:  {
      'circle-color': [
        'match', ['get', 'category'],
        'observatory', colors.observatory,
        /* default */ colors.station,
      ],
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        2, 4,
        8, 6,
        14, 10,
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(255,255,255,0.5)',
    },
  });

  // ── Location labels (only visible when zoomed in) ────────────────────
  map.addLayer({
    id:      'location-labels',
    type:    'symbol',
    source:  'locations',
    minzoom: 8,
    filter:  ['!', ['has', 'point_count']],
    layout:  {
      'text-field':         ['get', 'name'],
      'text-font':          ['DIN Offc Pro Regular', 'Arial Unicode MS Regular'],
      'text-size':          12,
      'text-offset':        [0, 1.2],
      'text-anchor':        'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color':      colors.textFill,
      'text-halo-color': colors.textHalo,
      'text-halo-width': 1,
    },
  });
}

function _updateStationCount() {
  const el = document.getElementById('station-count');
  if (el) el.textContent = `${_locations.length.toLocaleString()} stations`;
}
