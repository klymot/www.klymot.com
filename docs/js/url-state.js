/**
 * URL hash state serialisation and parsing.
 *
 * Hash formats:
 *   Map view:   #map=<zoom>/<lat>/<lng>/<projection>[/filters=<filter-state>]
 *   Station:    #station=<location-id>[;<section>;<mode>;<zoom>;<partial>;<anomaly>]
 *   Table view: #table=<sort-column>/<sort-direction>[/filters=<filter-state>]
 *
 * Filter state: filters=<filterId>:<bandIdx>[.<bandIdx>…][~<filterId>:…]
 *   e.g. filters=lat:0.2~bu_2020_1km:0
 *
 * Station detail fields (all optional, use '-' for absent):
 *   section:  qcu | qcf | bu | pop
 *   mode:     monthly | yearly | heatmap | anomaly | bymonth | 2020 | 1975 | change
 *   zoom:     <min>,<max>  (decimal years)
 *   partial:  'noest' when estimates hidden; 'noci' when est. shown but CI hidden; '-' when both shown (default)
 *   anomaly:  'inclsparse' to include years with <9 months; 'center30' to use the 30 centred full years as reference; 'notrend' to hide the trend line; 'loess' to enable LOESS; 'loessspan=NN' for span (10–90); combine with commas; '-' for defaults
 *   bymonth:  3-hex-digit bitmask of selected months (bit 0 = Jan … bit 11 = Dec); default '041' = Jan+Jul
 *   adjseries: comma-separated flags; 'nototal' hides Total series; 'notob' hides TOB series; 'nopha' hides PHA series; '-' for defaults (all shown)
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
 * Serialise active filter selections into a URL suffix string.
 * Returns '' if there are no active selections.
 * @param {Object} active  — { filterId: Set<number> }  (from filter-bar getActiveSelections)
 * @returns {string}  e.g. 'filters=lat:0.2~bu_2020_1km:0' or ''
 */
export function serialiseFilterState(active) {
  if (!active || typeof active !== 'object') return '';
  const parts = [];
  for (const [filterId, bands] of Object.entries(active)) {
    if (!(bands instanceof Set) || bands.size === 0) continue;
    const bandStr = [...bands].sort((a, b) => a - b).join('.');
    parts.push(`${filterId}:${bandStr}`);
  }
  return parts.length ? `filters=${parts.join('~')}` : '';
}

/**
 * Serialise the current map viewport to a hash fragment string.
 * @param {object} map          — MapLibre map instance
 * @param {string} projection   — 'mercator' | 'globe'
 * @param {object} [filterActive] — active filter selections (from filter-bar); omit for no filter state
 * @returns {string}  e.g. 'map=5.2/19.4721/-155.5922/globe'
 */
export function serialiseMapState(map, projection, filterActive = null) {
  const center = map.getCenter();
  const zoom   = map.getZoom().toFixed(1);
  const lat    = center.lat.toFixed(4);
  const lng    = center.lng.toFixed(4);
  const base   = `map=${zoom}/${lat}/${lng}/${projection}`;
  if (filterActive) {
    const fs = serialiseFilterState(filterActive);
    if (fs) return `${base}/${fs}`;
  }
  return base;
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
 * @param {boolean} [detail.showAnomalyTrend]              — whether to show the dashed trend line (default true)
 * @param {boolean} [detail.showLoess]                     — whether to show LOESS smooth line (default false)
 * @param {number}  [detail.loessSpan]                     — LOESS bandwidth span 0.1–0.9 (default 0.3)
 * @param {Set<number>} [detail.selectedMonths]            — bymonth mode: which months to display (default Jan+Jul)
 * @param {boolean} [detail.showTotal]                     — show Total series in adj chart (default true)
 * @param {boolean} [detail.showTob]                       — show TOB series in adj chart (default true)
 * @param {boolean} [detail.showPha]                       — show PHA series in adj chart (default true)
 * @returns {string}  e.g. 'station=USW00021514;qcu;yearly;1950.00,2024.00;-'
 */
export function serialiseStationState(locationId, detail = {}) {
  const encodedId = encodeURIComponent(locationId);

  const {
    section, mode, zoomMin, zoomMax, showEst, showCI,
    excludeSparseAnomalyYears, useCenteredAnomalyReference, showAnomalyTrend,
    showLoess, loessSpan,
    selectedMonths,
    showTotal, showTob, showPha,
  } = detail;

  // Build bymonth bitmask; default is Jan+Jul = 0x041.
  const _BYMONTH_DEFAULT = 0x041;
  let bymonthMask = _BYMONTH_DEFAULT;
  if (selectedMonths instanceof Set) {
    bymonthMask = 0;
    for (const m of selectedMonths) bymonthMask |= (1 << m);
  }

  // If no non-default detail state, emit the compact form.
  if (
    !section &&
    !mode &&
    zoomMin == null &&
    showEst !== false &&
    showCI !== false &&
    excludeSparseAnomalyYears !== false &&
    useCenteredAnomalyReference !== true &&
    showAnomalyTrend !== false &&
    !showLoess &&
    bymonthMask === _BYMONTH_DEFAULT &&
    showTotal !== false &&
    showTob !== false &&
    showPha !== false
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
  if (showLoess === true) {
    anomalyFlags.push('loess');
    const spanInt = Math.round((loessSpan ?? 0.3) * 100);
    if (spanInt !== 30) anomalyFlags.push(`loessspan=${spanInt}`);
  }
  const anomalyStr  = anomalyFlags.length ? anomalyFlags.join(',') : '-';
  const bymonthStr  = bymonthMask === _BYMONTH_DEFAULT ? '-' : bymonthMask.toString(16).padStart(3, '0');

  const adjSeriesFlags = [];
  if (showTotal === false) adjSeriesFlags.push('nototal');
  if (showTob === false) adjSeriesFlags.push('notob');
  if (showPha === false) adjSeriesFlags.push('nopha');
  const adjSeriesStr = adjSeriesFlags.length ? adjSeriesFlags.join(',') : '-';

  return `station=${encodedId};${sectionStr};${modeStr};${zoomStr};${partialStr};${anomalyStr};${bymonthStr};${adjSeriesStr}`;
}

/**
 * Serialise the aggregate graph view state to a hash fragment string.
 *
 * Hash format: graph=<series>/<mode>/<zoom>/<flags>[/filters=<filter-state>]
 *   series: qcu | qcf
 *   mode:   monthly | yearly | bymonth
 *   zoom:   <min>,<max> (decimal years) or '-'
 *   flags:  comma-separated; 'geo'=geo-gridded, 'ci'=show CI, 'notrend'=hide trend,
 *           'loess'=enable LOESS, 'loessspan=NN'=LOESS span, 'bymonth=NNN'=month mask
 *
 * @param {object} [detail]
 * @param {string}  [detail.series]      — 'qcu' | 'qcf'  (default 'qcu')
 * @param {string}  [detail.mode]        — chart mode       (default 'monthly')
 * @param {number}  [detail.zoomMin]
 * @param {number}  [detail.zoomMax]
 * @param {boolean} [detail.geoGridded]    — whether geo-gridded weighting is active
 * @param {boolean} [detail.fullYearsOnly] — whether only complete station-years contribute (default true)
 * @param {boolean} [detail.showCI]        — whether 95% CI bands are shown
 * @param {boolean} [detail.showTrend]     — whether trend line is shown (default true)
 * @param {number}  [detail.trendFromYear] — trend start year: 0=all, 1880, 1950 (default 0)
 * @param {boolean} [detail.showLoess]   — whether LOESS is shown (default false)
 * @param {number}  [detail.loessSpan]   — LOESS span 0.1–0.9 (default 0.3)
 * @param {Set<number>} [detail.selectedMonths] — bymonth mode selected months
 * @param {object}  [filterActive]       — active filter selections
 * @returns {string}  e.g. 'graph=qcu/monthly/-/ci,geo'
 */
export function serialiseGraphState(detail = {}, filterActive = null) {
  const {
    series = 'qcu',
    mode   = 'monthly',
    zoomMin, zoomMax,
    geoGridded, fullYearsOnly, showCI, showTrend, trendFromYear, showLoess, loessSpan,
    selectedMonths,
  } = detail;

  let zoomStr = '-';
  if (zoomMin != null && zoomMax != null && isFinite(zoomMin) && isFinite(zoomMax)) {
    zoomStr = `${zoomMin.toFixed(2)},${zoomMax.toFixed(2)}`;
  }

  const flags = [];
  if (geoGridded) flags.push('geo');
  if (fullYearsOnly === false) flags.push('nofullyr');
  if (showCI) flags.push('ci');
  if (showTrend === false) flags.push('notrend');
  if (trendFromYear) flags.push(`trendfrom=${trendFromYear}`);
  if (showLoess) {
    flags.push('loess');
    const spanInt = Math.round((loessSpan ?? 0.3) * 100);
    if (spanInt !== 30) flags.push(`loessspan=${spanInt}`);
  }
  const _BYMONTH_DEFAULT = 0x041;
  let bymonthMask = _BYMONTH_DEFAULT;
  if (selectedMonths instanceof Set) {
    bymonthMask = 0;
    for (const m of selectedMonths) bymonthMask |= (1 << m);
  }
  if (bymonthMask !== _BYMONTH_DEFAULT) {
    flags.push(`bymonth=${bymonthMask.toString(16).padStart(3, '0')}`);
  }

  const flagStr = flags.length ? flags.join(',') : '-';
  const base = `graph=${series}/${mode}/${zoomStr}/${flagStr}`;
  if (filterActive) {
    const fs = serialiseFilterState(filterActive);
    if (fs) return `${base}/${fs}`;
  }
  return base;
}

/**
 * Serialise the table sort state to a hash fragment string.
 * @param {string} sortColumn
 * @param {string} sortDirection  — 'asc' | 'desc'
 * @param {object} [filterActive] — active filter selections; omit for no filter state
 * @returns {string}  e.g. 'table=name/asc'
 */
export function serialiseTableState(sortColumn, sortDirection, filterActive = null) {
  const base = `table=${encodeURIComponent(sortColumn)}/${encodeURIComponent(sortDirection)}`;
  if (filterActive) {
    const fs = serialiseFilterState(filterActive);
    if (fs) return `${base}/${fs}`;
  }
  return base;
}

/**
 * Parse a URL hash string into a typed state object.
 * @param {string} hash  — raw hash including the leading '#', e.g. '#map=5/0/0/mercator'
 * @returns {{ type: 'map', zoom: number, lat: number, lng: number, projection: string }
 *          |{ type: 'station', id: string, section?: string, mode?: string,
 *             zoomMin?: number, zoomMax?: number, showEst?: boolean, showCI?: boolean,
 *             excludeSparseAnomalyYears?: boolean, useCenteredAnomalyReference?: boolean,
 *             showAnomalyTrend?: boolean, selectedMonths?: number[] }
 *          |{ type: 'table', sortColumn: string, sortDirection: string }
 *          |null}
 */
function _parseFilterSuffix(filterStr) {
  const result = {};
  if (!filterStr) return result;
  for (const part of filterStr.split('~')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx < 0) continue;
    const filterId   = part.slice(0, colonIdx);
    const bandIndices = part.slice(colonIdx + 1)
      .split('.')
      .map(Number)
      .filter(n => Number.isInteger(n) && n >= 0);
    if (filterId && bandIndices.length) result[filterId] = new Set(bandIndices);
  }
  return result;
}

export function parseHash(hash) {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return null;

  let result = null;
  let filterPart = '';

  if (raw.startsWith('map=')) {
    const parts = raw.slice(4).split('/');
    if (parts.length >= 4) {
      const zoom = parseFloat(parts[0]);
      const lat  = parseFloat(parts[1]);
      const lng  = parseFloat(parts[2]);
      const projection = parts[3];
      if (!isNaN(zoom) && !isNaN(lat) && !isNaN(lng) &&
          (projection === 'mercator' || projection === 'globe')) {
        result = { type: 'map', zoom, lat, lng, projection };
        // Optional 5th field: filters=...
        if (parts.length >= 5 && parts[4].startsWith('filters=')) {
          filterPart = parts[4];
        }
      }
    }
  } else if (raw.startsWith('station=')) {
    const rest  = raw.slice(8);
    const parts = rest.split(';');
    const id    = decodeURIComponent(parts[0]);
    if (id) {
      result = { type: 'station', id };

      if (parts.length >= 2 && parts[1] && parts[1] !== '-') {
        result.section = _SECTION_EXPAND[parts[1]] ?? parts[1];
      }
      if (parts.length >= 3 && parts[2] && parts[2] !== '-') {
        result.mode = parts[2];
      }
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
      const p4 = parts.length >= 5 ? parts[4] : '-';
      result.showEst = p4 !== 'noest';
      result.showCI  = p4 !== 'noest' && p4 !== 'noci';

      const p5 = parts.length >= 6 ? parts[5] : '-';
      const anomalyFlags = new Set((p5 && p5 !== '-') ? p5.split(',') : []);
      result.excludeSparseAnomalyYears   = !anomalyFlags.has('inclsparse');
      result.useCenteredAnomalyReference =  anomalyFlags.has('center30');
      result.showAnomalyTrend            = !anomalyFlags.has('notrend');
      result.showLoess                   =  anomalyFlags.has('loess');
      const loessSpanFlag = [...anomalyFlags].find(f => f.startsWith('loessspan='));
      result.loessSpan = loessSpanFlag ? parseInt(loessSpanFlag.slice(10), 10) / 100 : 0.3;

      const p6 = parts.length >= 7 ? parts[6] : '-';
      const bymonthMask = (p6 && p6 !== '-') ? parseInt(p6, 16) : 0x041;
      if (!isNaN(bymonthMask)) {
        const months = [];
        for (let i = 0; i < 12; i++) { if (bymonthMask & (1 << i)) months.push(i); }
        result.selectedMonths = months;
      }

      const p7 = parts.length >= 8 ? parts[7] : '-';
      const adjSeriesFlags = new Set((p7 && p7 !== '-') ? p7.split(',') : []);
      result.showTotal = !adjSeriesFlags.has('nototal');
      result.showTob   = !adjSeriesFlags.has('notob');
      result.showPha   = !adjSeriesFlags.has('nopha');
    }
  } else if (raw.startsWith('table=')) {
    const parts = raw.slice(6).split('/');
    if (parts.length >= 2) {
      result = {
        type:          'table',
        sortColumn:    decodeURIComponent(parts[0]),
        sortDirection: decodeURIComponent(parts[1]),
      };
      // Optional 3rd field: filters=...
      if (parts.length >= 3 && parts[2].startsWith('filters=')) {
        filterPart = parts[2];
      }
    }
  } else if (raw.startsWith('graph=')) {
    const parts = raw.slice(6).split('/');
    // parts: [series, mode, zoom, flags, ?filters=...]
    const series = parts[0];
    const mode   = parts[1];
    if ((series === 'qcu' || series === 'qcf') &&
        (mode === 'monthly' || mode === 'yearly' || mode === 'bymonth' ||
         mode === 'monthly-anomaly' || mode === 'yearly-anomaly')) {
      result = { type: 'graph', series, mode };

      const zoomStr = parts[2];
      if (zoomStr && zoomStr !== '-') {
        const zp = zoomStr.split(',');
        if (zp.length === 2) {
          const zMin = parseFloat(zp[0]);
          const zMax = parseFloat(zp[1]);
          if (isFinite(zMin) && isFinite(zMax)) {
            result.zoomMin = zMin;
            result.zoomMax = zMax;
          }
        }
      }

      const flagStr = parts[3];
      const flagSet = new Set((flagStr && flagStr !== '-') ? flagStr.split(',') : []);
      result.geoGridded    = flagSet.has('geo');
      result.fullYearsOnly = !flagSet.has('nofullyr');
      result.showCI        = flagSet.has('ci');
      result.showTrend  = !flagSet.has('notrend');
      const trendFromFlag = [...flagSet].find(f => f.startsWith('trendfrom='));
      result.trendFromYear = trendFromFlag ? parseInt(trendFromFlag.slice(10), 10) : 0;
      result.showLoess  =  flagSet.has('loess');
      const loessSpanFlag = [...flagSet].find(f => f.startsWith('loessspan='));
      result.loessSpan  = loessSpanFlag ? parseInt(loessSpanFlag.slice(10), 10) / 100 : 0.3;
      const bymonthFlag = [...flagSet].find(f => f.startsWith('bymonth='));
      if (bymonthFlag) {
        const mask = parseInt(bymonthFlag.slice(8), 16);
        if (!isNaN(mask)) {
          const months = [];
          for (let i = 0; i < 12; i++) { if (mask & (1 << i)) months.push(i); }
          result.selectedMonths = months;
        }
      }

      // Optional 5th field: filters=...
      if (parts.length >= 5 && parts[4].startsWith('filters=')) {
        filterPart = parts[4];
      }
    }
  }

  if (!result) return null;

  // Attach filter state if present
  if (filterPart.startsWith('filters=')) {
    result.filters = _parseFilterSuffix(filterPart.slice(8));
  }

  return result;
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
