/**
 * URL hash state serialisation and parsing.
 *
 * Hash formats:
 *   Map view:   #map=<zoom>/<lat>/<lng>/<projection>
 *   Station:    #station=<location-id>
 *   Table view: #table=<sort-column>/<sort-direction>
 *
 * Theme is intentionally excluded — it is a user preference stored in
 * localStorage, not part of shareable state.
 */

/**
 * Serialise the current map viewport to a hash fragment string.
 * @param {object} map         — MapLibre map instance
 * @param {string} projection  — 'mercator' | 'globe'
 * @returns {string}  e.g. 'map=5.2/19.47/-155.59/globe'
 */
export function serialiseMapState(map, projection) {
  const center = map.getCenter();
  const zoom   = map.getZoom().toFixed(1);
  const lat    = center.lat.toFixed(2);
  const lng    = center.lng.toFixed(2);
  return `map=${zoom}/${lat}/${lng}/${projection}`;
}

/**
 * Serialise a selected station to a hash fragment string.
 * @param {string} locationId
 * @returns {string}  e.g. 'station=mauna-loa'
 */
export function serialiseStationState(locationId) {
  return `station=${encodeURIComponent(locationId)}`;
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
 *          |{ type: 'station', id: string }
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
    const id = decodeURIComponent(raw.slice(8));
    if (!id) return null;
    return { type: 'station', id };
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
