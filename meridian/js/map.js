const STYLES = {
  dark:  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
};

// Layer IDs present in Carto dark-matter / positron that control
// land and water colours. Missing layers are silently skipped.
const LAYER_COLORS = {
  dark: {
    background:             ['background-color', '#0a1628'],
    water:                  ['fill-color',       '#0f2847'],
    'water-shadow':         ['fill-color',       '#0a1628'],
    landcover:              ['fill-color',       '#2d6b45'],
    landuse:                ['fill-color',       '#264d36'],
    'national-park':        ['fill-color',       '#264d36'],
  },
  light: {
    background:             ['background-color', '#a8cce4'],
    water:                  ['fill-color',       '#a8cce4'],
    'water-shadow':         ['fill-color',       '#90b8d0'],
    landcover:              ['fill-color',       '#c8d8a8'],
    landuse:                ['fill-color',       '#b8cc90'],
    'national-park':        ['fill-color',       '#b8cc90'],
  },
};

let map = null;
let currentProjection = 'mercator';

export function initMap(theme) {
  /* global maplibregl */
  map = new maplibregl.Map({
    container: 'map',
    style: STYLES[theme] ?? STYLES.dark,
    projection: currentProjection,
    center: [10, 20],
    zoom: 1.5,
    minZoom: 1,
    maxZoom: 16,
    renderWorldCopies: true,
    attributionControl: false,
  });

  map.on('load', () => {
    applyMapColors(theme);
    map.setProjection(currentProjection);
  });

  return map;
}

export function getMap() {
  return map;
}

export function setProjection(projection) {
  if (!map) return;
  currentProjection = projection;
  map.setProjection(projection);
}

export function getProjection() {
  return currentProjection;
}

export function updateMapTheme(theme) {
  if (!map) return;
  map.setStyle(STYLES[theme] ?? STYLES.dark);
  map.once('style.load', () => {
    applyMapColors(theme);
    map.setProjection(currentProjection);
  });
}

function applyMapColors(theme) {
  const colors = LAYER_COLORS[theme];
  if (!colors) return;
  for (const [layerId, [prop, color]] of Object.entries(colors)) {
    try {
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, prop, color);
      }
    } catch {
      // Layer absent in this style variant — ignore.
    }
  }
}
