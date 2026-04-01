// Replace with your Mapbox public token.
// Obtain one at https://account.mapbox.com/
export const MAPBOX_TOKEN = 'pk.PLACEHOLDER_TOKEN';

const STYLES = {
  dark:  'mapbox://styles/mapbox/dark-v11',
  light: 'mapbox://styles/mapbox/light-v11',
};

// Layer IDs present in both dark-v11 and light-v11 that control
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
  /* global mapboxgl */
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
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
