/**
 * URL hash state serialisation and parsing.
 *
 * Hash formats:
 *   Map view:   #map=<zoom>/<lat>/<lng>/<projection>
 *   Station:    #station=<location-id>[;<section>;<mode>;<zoom>;<partial>;<anomaly>]
 *   Table view: #table=<sort-column>/<sort-direction>
 *
 * Station detail fields (all optional, use '-' for absent):
 *   section:  qcu | qcf | bu | pop
 *   mode:     monthly | yearly | heatmap | anomaly | 2020 | 1975 | change
 *   zoom:     <min>,<max>  (decimal years)
 *   partial:  'noest' when estimates hidden; 'noci' when est. shown but CI hidden; '-' when both shown (default)
 *   anomaly:  'inclsparse' to include years with <9 months; 'center30' to use the 30 centred full years as reference; 'notrend' to hide the anomaly trend line; combine with commas; '-' for defaults
 *
 * Theme is intentionally excluded — it is a user preference stored in
 * localStorage, not part of shareable state.
 */

const _SECTION_ABBREV = {
  'temp-qcu': 'qcu', 'temp-qcf': 'qcf',
  'bu-surface': 'bu', 'population': 'pop',
};
const _SECTION_EXPAND = {
  'qcu': 'temp-qcu', 'qcf': 'temp-qcf',
  'bu': 'bu-surface', 'pop': 'population',
};

/**
 * Serialise the current map viewport to a hash fragment string.
 * @param {object} map         — MapLibre map instance
 * @param {string} projection  — 'mercator' | 'globe'
 * @returns {string}  e.g. 'map=5.2/19.4721/-155.5922/globe'
 */
export function serialiseMapState(map, projection) {
  const center = map.getCenter();
  const zoom   = map.getZoom().toFixed(1);
  const lat    = center.lat.toFixed(4);
  const lng    = center.lng.toFixed(4);
  return `map=${zoom}/${lat}/${lng}/${projection}`;
}

/**
 * Serialise a selected station to a hash fragment string.
 * @param {string} locationId
 * @param {object} [detail]  — optional detail panel state
 * @param {string}  [detail.section]  — active section name (e.g. 'temp-qcu')
 * @param {string}  [detail.mode]     — chart mode or year tab
 * @param {number}  [detail.zoomMin]
 * @param {number}  [detail.zoomMax]
 * @param {boolean} [detail.showEst]  — whether partial-year estimates are visible (default true)
 * @param {boolean} [detail.showCI]   — whether 95% CI bands are visible (default true)
 * @param {boolean} [detail.excludeSparseAnomalyYears]     — whether anomaly mode hides years with <9 months (default true)
 * @param {boolean} [detail.useCenteredAnomalyReference]   — whether anomaly mode uses the 30 full years nearest the record centre (default false)
 * @param {boolean} [detail.showAnomalyTrend]              — whether anomaly mode shows the dashed trend line (default true)
 * @returns {string}  e.g. 'station=mauna-loa;qcu;yearly;1950.00,2024.00;-'
 */
export function serialiseStationState(locationId, detail = {}) {
  const encodedId = encodeURIComponent(locationId);

  const {
    section, mode, zoomMin, zoomMax, showEst, showCI,
    excludeSparseAnomalyYears, useCenteredAnomalyReference, showAnomalyTrend,
  } = detail;

  // If no non-default detail state, emit the compact form.
  if (
    !section &&
    !mode &&
    zoomMin == null &&
    showEst !== false &&
    showCI !== false &&
    excludeSparseAnomalyYears !== false &&
    useCenteredAnomalyReference !== true &&
    showAnomalyTrend !== false
  ) {
    return `station=${encodedId}`;
  }

  const sectionStr = section ? (_SECTION_ABBREV[section] ?? section) : '-';
  const modeStr    = mode    || '-';

  let zoomStr = '-';
  if (zoomMin != null && zoomMax != null && isFinite(zoomMin) && isFinite(zoomMax)) {
    zoomStr = `${zoomMin.toFixed(2)},${zoomMax.toFixed(2)}`;
  }

  // Partial-year state: 'noest' = estimates off; 'noci' = estimates on, CI off; '-' = both on.
  const partialStr = showEst === false ? 'noest' : showCI === false ? 'noci' : '-';
  const anomalyFlags = [];
  if (excludeSparseAnomalyYears === false) anomalyFlags.push('inclsparse');
  if (useCenteredAnomalyReference === true) anomalyFlags.push('center30');
  if (showAnomalyTrend === false) anomalyFlags.push('notrend');
  const anomalyStr = anomalyFlags.length ? anomalyFlags.join(',') : '-';

  return `station=${encodedId};${sectionStr};${modeStr};${zoomStr};${partialStr};${anomalyStr}`;
}

/**
 * Serialise the table sort state to a hash fragment string.
 * @param {string} sortColumn
 * @param {string} sortDirection  — 'asc' | 'desc'
 * @returns {string}  e.g. 'table=name/asc'
 */
export function serialiseTableState(sortColumn, sortDirection) {
  return `table=${encodeURIComponent(sortColumn)}/${encodeURIComponent(sortDirection)}`;
}

/**
 * Parse a URL hash string into a typed state object.
 * @param {string} hash  — raw hash including the leading '#', e.g. '#map=5/0/0/mercator'
 * @returns {{ type: 'map', zoom: number, lat: number, lng: number, projection: string }
 *          |{ type: 'station', id: string, section?: string, mode?: string,
 *             zoomMin?: number, zoomMax?: number, showEst?: boolean, showCI?: boolean,
 *             excludeSparseAnomalyYears?: boolean, useCenteredAnomalyReference?: boolean,
 *             showAnomalyTrend?: boolean }
 *          |{ type: 'table', sortColumn: string, sortDirection: string }
 *          |null}
 */
export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return null;

  if (raw.startsWith('map=')) {
    const parts = raw.slice(4).split('/');
    if (parts.length < 4) return null;
    const zoom = parseFloat(parts[0]);
    const lat  = parseFloat(parts[1]);
    const lng  = parseFloat(parts[2]);
    const projection = parts[3];
    if (isNaN(zoom) || isNaN(lat) || isNaN(lng)) return null;
    if (projection !== 'mercator' && projection !== 'globe') return null;
    return { type: 'map', zoom, lat, lng, projection };
  }

  if (raw.startsWith('station=')) {
    const rest  = raw.slice(8);
    const parts = rest.split(';');
    const id    = decodeURIComponent(parts[0]);
    if (!id) return null;

    const result = { type: 'station', id };

    // section (index 1)
    if (parts.length >= 2 && parts[1] && parts[1] !== '-') {
      result.section = _SECTION_EXPAND[parts[1]] ?? parts[1];
    }

    // mode (index 2)
    if (parts.length >= 3 && parts[2] && parts[2] !== '-') {
      result.mode = parts[2];
    }

    // zoom (index 3): "min,max"
    if (parts.length >= 4 && parts[3] && parts[3] !== '-') {
      const zp = parts[3].split(',');
      if (zp.length === 2) {
        const zMin = parseFloat(zp[0]);
        const zMax = parseFloat(zp[1]);
        if (isFinite(zMin) && isFinite(zMax)) {
          result.zoomMin = zMin;
          result.zoomMax = zMax;
        }
      }
    }

    // Partial-year state (index 4): 'noest' = estimates off; 'noci' = est on, CI off; '-'/absent = both on.
    const p4 = parts.length >= 5 ? parts[4] : '-';
    result.showEst = p4 !== 'noest';
    result.showCI  = p4 !== 'noest' && p4 !== 'noci';

    // Annual anomaly state (index 5): defaults are exclude sparse years and use all full years.
    const p5 = parts.length >= 6 ? parts[5] : '-';
    const anomalyFlags = new Set((p5 && p5 !== '-') ? p5.split(',') : []);
    result.excludeSparseAnomalyYears = !anomalyFlags.has('inclsparse');
    result.useCenteredAnomalyReference = anomalyFlags.has('center30');
    result.showAnomalyTrend = !anomalyFlags.has('notrend');

    return result;
  }

  if (raw.startsWith('table=')) {
    const parts = raw.slice(6).split('/');
    if (parts.length < 2) return null;
    return {
      type:          'table',
      sortColumn:    decodeURIComponent(parts[0]),
      sortDirection: decodeURIComponent(parts[1]),
    };
  }

  return null;
}

/**
 * Update the URL hash without adding a browser history entry.
 * @param {string} hashString  — fragment without the leading '#'
 */
export function pushState(hashString) {
  history.replaceState(null, '', '#' + hashString);
}

/**
 * Register a listener for browser hash-change events (back/forward navigation
 * or the user editing the address bar).
 * @param {function} callback
 */
export function onHashChange(callback) {
  window.addEventListener('hashchange', callback);
}
