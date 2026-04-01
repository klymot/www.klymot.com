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
    background:             ['background-color', '#edf2e6'],
    water:                  ['fill-color',       '#9fc7df'],
    'water-shadow':         ['fill-color',       '#84b2cf'],
    landcover:              ['fill-color',       '#cbd8a0'],
    landuse:                ['fill-color',       '#b9cc8a'],
    'national-park':        ['fill-color',       '#b9cc8a'],
  },
};

let map = null;
let currentProjection = 'globe';
let _projectionRetryTimer = null;

// Tracks the active theme so the persistent style.load listener always applies
// the correct colours regardless of what triggered the style reload.
let _activeTheme = 'dark';

export function initMap(theme) {
  _activeTheme = theme;

  /* global maplibregl */
  map = new maplibregl.Map({
    container: 'map',
    // Start from a blank style, then apply the themed Carto style through
    // setStyle() so we can transform the incoming JSON before MapLibre commits
    // it. That avoids the base style briefly winning and then overwriting our
    // runtime paint changes.
    style: { version: 8, sources: {}, layers: [] },
    projection: { type: currentProjection },
    center: [10, 20],
    zoom: 1.5,
    minZoom: 1,
    maxZoom: 16,
    renderWorldCopies: true,
    attributionControl: false,
  });

  // Keep Mercator north-up across desktop and mobile interactions.
  map.dragRotate?.disable?.();
  map.touchZoomRotate?.disableRotation?.();
  map.touchPitch?.disable?.();

  // setStyle() can reset projection during initial boot and theme changes.
  // Keep the runtime projection aligned with module state after every style load.
  map.on('style.load', () => {
    _syncProjectionToStyle();
  });

  setBaseStyle(theme);

  return map;
}

export function getMap() {
  return map;
}

export function supportsProjection() {
  return Boolean(map && typeof map.setProjection === 'function');
}

export function setProjection(projection) {
  if (!map) return;

  currentProjection = projection;
  _syncProjectionToStyle();
}

export function getProjection() {
  return currentProjection;
}

export function updateMapTheme(theme) {
  if (!map) return;
  _activeTheme = theme;
  setBaseStyle(theme);
}

function setBaseStyle(theme) {
  map.setStyle(STYLES[theme] ?? STYLES.dark, {
    diff: false,
    transformStyle: (_previousStyle, nextStyle) => applyThemeToStyle(nextStyle, theme),
  });
}

function _syncProjectionToStyle() {
  if (!supportsProjection()) return;
  const projectionState = map.getProjection?.();
  const activeProjection = projectionState?.name ?? projectionState?.type ?? 'mercator';
  if (activeProjection === currentProjection) {
    globalThis.clearTimeout(_projectionRetryTimer);
    _projectionRetryTimer = null;
    return;
  }

  try {
    map.setProjection({ type: currentProjection });
  } catch (_err) {
    // MapLibre throws while the style is still booting; retry shortly so a
    // user click takes effect as soon as the style is ready.
  }

  globalThis.clearTimeout(_projectionRetryTimer);
  _projectionRetryTimer = globalThis.setTimeout(() => {
    _syncProjectionToStyle();
  }, 100);
  map.once?.('idle', () => {
    _syncProjectionToStyle();
  });
}

function applyThemeToStyle(style, theme) {
  const colors = LAYER_COLORS[theme];
  if (!colors?.background || !Array.isArray(style?.layers)) return style;

  const themedLayers = style.layers.map(layer => {
    const override = colors[layer.id];
    if (!override) return layer;

    const [prop, color] = override;
    return {
      ...layer,
      paint: {
        ...(layer.paint ?? {}),
        [prop]: color,
      },
    };
  });

  return {
    ...style,
    transition: { duration: 0, delay: 0 },
    layers: themedLayers,
  };
}
