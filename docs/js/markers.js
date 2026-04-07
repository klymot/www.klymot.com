import { getMap } from './map.js?v=20260406';

// ── Module state ─────────────────────────────────────────────────────────────
let _locations         = [];
let _buSprites         = { bu2020: null, bu1975: null, pop2020: null, pop1975: null };
let _featureCollection = null;
let _currentTheme      = 'dark';
let _syncRetryTimer    = null;
let _filteredIds       = null; // null = show all; Set<string> = filtered subset

// ── Colour palette ───────────────────────────────────────────────────────────
const COLORS = {
  dark: {
    observatory:  '#5ca8c4',
    station:      '#d4a855',
    textFill:     '#e8d5a3',
    textHalo:     'rgba(10,22,40,0.8)',
    geoLines:     'rgba(212, 168, 85, 0.40)',
  },
  light: {
    observatory:  '#1e6e90',
    station:      '#7a5f20',
    textFill:     '#3d2b1f',
    textHalo:     'rgba(244,240,232,0.8)',
    geoLines:     'rgba(100, 80, 20, 0.45)',
  },
};

const SOURCE_ID = 'locations';
const LAYER_IDS = {
  clusters: 'clusters',
  clusterCount: 'cluster-count',
  markers: 'location-markers',
  labels: 'location-labels',
};

// Geographic reference lines (Arctic Circle, Tropic of Cancer/Capricorn, Antarctic Circle)
const GEO_LINES_SOURCE = 'geographic-lines';
const GEO_LINES_LAYER  = 'geographic-lines-layer';
const GEO_LABELS_LAYER  = 'geographic-line-labels-layer';
const GEO_LATITUDES    = [66.5, 23.4, 0, -23.4, -66.5];

// ── Public API ───────────────────────────────────────────────────────────────

/** Return the loaded location array (consumed by table-view, detail-panel, etc.). */
export function getLocations() {
  return _locations;
}

/** Return sprite descriptors { bu2020, bu1975, pop2020, pop1975 } (any may be null if not generated). */
export function getBuSprite() {
  return _buSprites;
}

/**
 * Fetch index.json, add clustered GeoJSON source + 4 layers, wire click events.
 * Must be called after initMap().
 */
export async function initMarkers(theme) {
  _currentTheme = theme;
  const map = getMap();

  // Retry marker attachment across the style lifecycle. The live MapLibre 5 +
  // Carto basemap combination can reject custom layer insertion briefly during
  // style rebuilds even after style events have started firing.
  for (const eventName of ['load', 'styledata', 'style.load', 'idle']) {
    map.on(eventName, () => {
      _syncLayers();
    });
  }

  const resp = await fetch('data/index.json');
  const { locations, bu_2020_sprite, bu_1975_sprite, pop_2020_sprite, pop_1975_sprite } = await resp.json();
  _locations = locations;
  _buSprites = {
    bu2020:  bu_2020_sprite  ?? null,
    bu1975:  bu_1975_sprite  ?? null,
    pop2020: pop_2020_sprite ?? null,
    pop1975: pop_1975_sprite ?? null,
  };
  _featureCollection = _toGeoJSON(locations);
  _updateStationCount();

  _syncLayers();

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

/**
 * Restrict which locations are shown on the map.
 * Pass null to show all locations.
 */
export function setFilteredLocations(filteredIds) {
  _filteredIds = filteredIds ? new Set(filteredIds) : null;
  _applySourceFilter();
  _updateStationCount();
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

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type:           'geojson',
      data:           _featureCollection,
      cluster:        true,
      clusterRadius:  50,
      clusterMaxZoom: 10,
    });
  }

  // ── Cluster circles ──────────────────────────────────────────────────
  _addLayerIfMissing({
    id:     LAYER_IDS.clusters,
    type:   'circle',
    source: SOURCE_ID,
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
  _addLayerIfMissing({
    id:     LAYER_IDS.clusterCount,
    type:   'symbol',
    source: SOURCE_ID,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font':  ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      'text-size':  12,
    },
    paint: { 'text-color': '#ffffff' },
  });

  // ── Unclustered markers ──────────────────────────────────────────────
  _addLayerIfMissing({
    id:     LAYER_IDS.markers,
    type:   'circle',
    source: SOURCE_ID,
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
  _addLayerIfMissing({
    id:      LAYER_IDS.labels,
    type:    'symbol',
    source:  SOURCE_ID,
    minzoom: 8,
    filter:  ['!', ['has', 'point_count']],
    layout:  {
      'text-field':         ['get', 'name'],
      'text-font':          ['Open Sans Regular', 'Arial Unicode MS Regular'],
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

function _syncLayers() {
  if (!_featureCollection) return;
  clearTimeout(_syncRetryTimer);

  try {
    const map = getMap();
    if (!map?.getStyle?.()) return;
    _addGeographicLines();
    _addLayers();
    _applySourceFilter();
  } catch (_err) {
    _syncRetryTimer = setTimeout(() => {
      _syncLayers();
    }, 100);
  }
}

function _addLayerIfMissing(config) {
  const map = getMap();
  if (map.getLayer(config.id)) return;
  map.addLayer(config);
}

function _updateStationCount() {
  const el = document.getElementById('station-count');
  if (!el) return;
  const total = _locations.length;
  const shown = _filteredIds !== null ? _filteredIds.size : total;
  el.textContent = shown === total
    ? `${total.toLocaleString()} stations`
    : `${shown.toLocaleString()} of ${total.toLocaleString()} stations`;
}

function _applySourceFilter() {
  const map = getMap();
  const src = map?.getSource?.(SOURCE_ID);
  if (!src || !_featureCollection) return;
  if (_filteredIds === null) {
    src.setData(_featureCollection);
  } else {
    src.setData({
      type: 'FeatureCollection',
      features: _featureCollection.features.filter(f => _filteredIds.has(f.properties.id)),
    });
  }
}

function _latLineFeature(lat) {
  const label = lat === 66.5
    ? 'ARCTIC CIRCLE'
    : lat === 23.4
      ? 'TROPIC OF CANCER'
      : lat === 0
        ? 'EQUATOR'
        : lat === -23.4
          ? 'TROPIC OF CAPRICORN'
          : 'ANTARCTIC CIRCLE';

  // 37 points every 10° for smooth globe rendering
  return {
    type: 'Feature',
    properties: { lat, label },
    geometry: {
      type: 'LineString',
      coordinates: Array.from({ length: 37 }, (_, i) => [-180 + i * 10, lat]),
    },
  };
}

function _addGeographicLines() {
  const map    = getMap();
  const colors = COLORS[_currentTheme] ?? COLORS.dark;

  if (!map.getSource(GEO_LINES_SOURCE)) {
    map.addSource(GEO_LINES_SOURCE, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: GEO_LATITUDES.map(_latLineFeature),
      },
    });
  }

  _addLayerIfMissing({
    id:     GEO_LINES_LAYER,
    type:   'line',
    source: GEO_LINES_SOURCE,
    paint:  {
      'line-color':     colors.geoLines,
      'line-width':     1,
      'line-dasharray': [5, 5],
      'line-opacity':   1,
    },
  });

  _addLayerIfMissing({
    id:     GEO_LABELS_LAYER,
    type:   'symbol',
    source: GEO_LINES_SOURCE,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      'symbol-placement': 'line',
      'symbol-spacing': 500,
      'text-size': [
        'interpolate', ['linear'], ['zoom'],
        1, 10,
        3, 12,
      ],
      'text-max-width': 100,
      'text-keep-upright': true,
      'text-rotation-alignment': 'map',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': colors.geoLines,
      'text-opacity': 0.8,
    },
  });
}
