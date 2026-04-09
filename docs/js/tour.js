// ── Guided Tour (driver.js) ────────────────────────────────────────────────────

const TOUR_SEEN_KEY = 'klymot-tour-seen';

function hasTourBeenSeen() {
  return !!localStorage.getItem(TOUR_SEEN_KEY);
}

function markTourSeen() {
  localStorage.setItem(TOUR_SEEN_KEY, '1');
}

/**
 * Returns true when the URL carries meaningful user-chosen state: a station
 * detail panel, table view, or active filters. A bare #map=… hash (the
 * default position that the app writes on every load) is NOT meaningful.
 */
function _hasSignificantState() {
  const hash = window.location.hash.slice(1);
  if (!hash) return false;
  if (hash.startsWith('station=')) return true;
  if (hash.startsWith('table=')) return true;
  if (hash.startsWith('map=') && hash.includes('/filters=')) return true;
  return false;
}

export function initTour() {
  const btn = document.getElementById('tour-btn');
  if (!btn) return;

  // Show a pulse hint when the user has never seen the tour and has not
  // navigated to any meaningful state (station, table, or filtered map).
  // A bare #map=… position hash (written automatically on every load) is
  // treated the same as no hash.
  if (!hasTourBeenSeen() && !_hasSignificantState()) {
    btn.classList.add('tour-btn-hint');

    const removeHint = () => btn.classList.remove('tour-btn-hint');

    // Remove once the user opens a station or applies filters
    const onHash = () => { if (_hasSignificantState()) removeHint(); };
    window.addEventListener('hashchange', onHash);

    // Remove after 20 s regardless
    setTimeout(() => {
      window.removeEventListener('hashchange', onHash);
      removeHint();
    }, 20_000);
  }

  btn.addEventListener('click', () => {
    btn.classList.remove('tour-btn-hint');
    markTourSeen();
    _startTour();
  });
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

/** Query scoped to the detail panel. */
function _pq(selector) {
  return document.querySelector(`#detail-panel ${selector}`);
}

/**
 * Programmatically search for `text` in the station search box, then click the
 * first result containing `matchText`. Calls `onDone` when done (or immediately
 * if nothing is found).
 */
function _searchAndClick(text, matchText, onDone) {
  const input    = document.getElementById('station-search-input');
  const dropdown = document.getElementById('station-dropdown');
  if (!input || !dropdown) { onDone(); return; }

  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));

  setTimeout(() => {
    const match = Array.from(dropdown.querySelectorAll('li'))
      .find(li => li.textContent.toLowerCase().includes(matchText.toLowerCase()));
    if (match) match.click();
    onDone();
  }, 350);
}

/** Click the detail panel's close button if it is currently open. */
function _closeDetailPanel(onDone) {
  const closeBtn = document.querySelector('.detail-close');
  if (closeBtn) {
    closeBtn.click();
    setTimeout(onDone, 450);
  } else {
    onDone();
  }
}

// ── Tour ───────────────────────────────────────────────────────────────────────

function _startTour() {
  const driverFn = window.driver?.js?.driver;
  if (!driverFn) {
    console.error('driver.js not loaded');
    return;
  }

  // Aggregate graph steps are only shown when the API server is reachable
  // (indicated by the Graph button being visible and enabled).
  const _aggregateAvailable = !document.querySelector('.view-btn[data-view="aggregate"]')?.hidden;

  // `driverObj` is referenced inside step callbacks — assigned just below.
  let driverObj;

  driverObj = driverFn({
    showProgress: true,
    animate: true,
    allowClose: true,
    overlayOpacity: 0.4,
    steps: [

      // ── 1. Welcome ──────────────────────────────────────────────────
      {
        popover: {
          title: 'Welcome to Klymot',
          description:
            'An interactive explorer for GHCN weather station data. ' +
            'This tour will walk you through the key features using ' +
            'Valentia Observatory — one of Europe\'s longest-running ' +
            'weather stations — as a live example.',
          align: 'start',
        },
      },

      // ── 2. Search → auto-opens Valentia on Next ─────────────────────
      {
        element: '#header-station-search',
        popover: {
          title: 'Search Stations',
          description:
            'Type any station name or ID to jump to it. ' +
            'Click <strong>Next</strong> and we\'ll search for ' +
            '<em>Valentia Observatory</em> live.',
          side: 'bottom',
          align: 'start',
          onNextClick: () => {
            _searchAndClick('Valentia', 'Valentia Observatory', () => {
              // Allow time for map flyTo and detail panel to open
              setTimeout(() => driverObj.moveNext(), 1400);
            });
          },
        },
      },

      // ── 3. Detail header (panel is now open) ────────────────────────
      {
        element: '.detail-header',
        popover: {
          title: 'Valentia Observatory',
          description:
            'Records here go back to <strong>1869</strong> — over 155 years ' +
            'of continuous measurement. The header shows the station name, ' +
            'coordinates, and elevation.',
          side: 'left',
          align: 'start',
        },
      },

      // ── 4. Section tabs ─────────────────────────────────────────────
      {
        element: '.section-tabs',
        popover: {
          title: 'Data Sections',
          description:
            'Switch between <strong>Unadjusted</strong> and ' +
            '<strong>Adjusted</strong> temperature records, the ' +
            '<strong>Adjustments</strong> breakdown, and built-up area ' +
            'or population data around the station.',
          side: 'bottom',
          align: 'start',
        },
      },

      // ── 5. Trend & LOESS toggles (visible in default Monthly mode) ──
      {
        element: '.chart-trend-controls',
        popover: {
          title: 'Trend & LOESS Smoothing',
          description:
            'Toggle the linear <strong>Trend</strong> line on or off. ' +
            'Enable <strong>LOESS</strong> to overlay a non-parametric ' +
            'smooth curve that follows the data without assuming a straight line.',
          side: 'top',
          align: 'start',
          onNextClick: () => {
            // Switch to By Month mode so the month toggles become visible
            _pq('[data-section="temp-qcu"] .chart-mode-btn[data-mode="bymonth"]')?.click();
            setTimeout(() => driverObj.moveNext(), 350);
          },
        },
      },

      // ── 6. By Month toggles (now visible after switching mode) ──────
      {
        element: '.chart-month-toggles',
        popover: {
          title: 'By Month View',
          description:
            'In <strong>By Month</strong> mode each calendar month gets ' +
            'its own line. Toggle individual months on or off to compare ' +
            'seasonal patterns — useful for spotting which months are ' +
            'driving a long-term trend.',
          side: 'top',
          align: 'start',
          onNextClick: () => {
            // Navigate to the Built-Up section
            document.querySelector('#detail-panel .section-tab[data-section="bu-surface"]')?.click();
            setTimeout(() => driverObj.moveNext(), 400);
          },
        },
      },

      // ── 7. Built-Up section sub-tabs ────────────────────────────────
      {
        element: '.bu-tabs',
        popover: {
          title: 'Built-Up Area',
          description:
            'Compare satellite-derived built-up surface around the station ' +
            'in <strong>2020</strong>, <strong>1975</strong>, and the ' +
            '<strong>Change</strong> between the two. ' +
            'High urbanisation near a station can introduce a warming bias ' +
            'in the raw temperature record.',
          side: 'bottom',
          align: 'start',
        },
      },

      // ── 8. Download button ──────────────────────────────────────────
      {
        element: '.detail-download-btn',
        popover: {
          title: 'Download Report',
          description:
            'Export the current station view as a <strong>PNG image</strong> ' +
            'or a multi-page <strong>PDF report</strong> containing all ' +
            'charts and data sections.',
          side: 'left',
          align: 'start',
        },
      },

      // ── 9. Close button → closes panel on Next ──────────────────────
      {
        element: '.detail-close',
        popover: {
          title: 'Close & Return',
          description:
            'Click <strong>×</strong> to close the detail panel and return ' +
            'to the map. Your position in the map is preserved. ' +
            'Click <strong>Next</strong> and we\'ll close it now.',
          side: 'left',
          align: 'start',
          onNextClick: () => {
            _closeDetailPanel(() => driverObj.moveNext());
          },
        },
      },

      // ── 10. Filter toggle ───────────────────────────────────────────
      {
        element: '#filter-toggle',
        popover: {
          title: 'Filter Stations',
          description:
            'Open the filter bar to narrow stations by latitude band, ' +
            'built-up area, population, trend magnitude, and more. ' +
            'The map updates instantly to show only the stations that match.',
          side: 'bottom',
          align: 'start',
        },
      },

      // ── 11. View toggle ─────────────────────────────────────────────
      {
        element: '.view-toggle',
        popover: {
          title: 'Switch Views',
          description: _aggregateAvailable
            ? 'Display stations on a flat Mercator map, a rotatable globe, ' +
              'a sortable data table, or an <strong>Aggregate Graph</strong> — ' +
              'a multi-station temperature chart built from all currently ' +
              'filtered stations. Click <strong>Next</strong> and we\'ll open it.'
            : 'Display stations on a flat Mercator map, a rotatable globe, ' +
              'or a sortable data table.',
          side: 'bottom',
          align: 'end',
          // onNextClick must be absent (not undefined) when aggregate is
          // unavailable — driver.js treats the key's presence as a signal
          // to intercept Next, even when the value is undefined.
          ...(_aggregateAvailable ? {
            onNextClick: () => {
              document.querySelector('.view-btn[data-view="aggregate"]')?.click();
              setTimeout(() => driverObj.moveNext(), 800);
            },
          } : {}),
        },
      },

      // ── 12. Aggregate graph (shown only when API is reachable) ───────
      ...(_aggregateAvailable ? [{
        element: '#aggregate-container',
        popover: {
          title: 'Aggregate Graph',
          description:
            'Averages temperature records across every station in the current ' +
            'filtered set. Choose between <strong>Monthly</strong>, ' +
            '<strong>By Month</strong>, <strong>Annual</strong>, ' +
            '<strong>Monthly Anomaly</strong>, and <strong>Annual Anomaly</strong> ' +
            'modes. <strong>Geo-gridded</strong> weights stations by ' +
            'cos(latitude) so polar regions don\'t dominate. ' +
            '<strong>Full years</strong> (on by default) restricts each ' +
            'station to years where all 12 months are present, preventing ' +
            'seasonal gaps from biasing the mean. ' +
            'Shaded <strong>95% CI</strong> bands and a weighted ' +
            'trend line are also available. ' +
            'Click <strong>Next</strong> to return to the map.',
          side: 'top',
          align: 'start',
          onNextClick: () => {
            document.querySelector('.view-btn[data-view="globe"]')?.click();
            setTimeout(() => driverObj.moveNext(), 600);
          },
        },
      }] : []),

      // ── 13. Map ─────────────────────────────────────────────────────
      {
        element: '#map',
        popover: {
          title: 'Explore the Map',
          description:
            'Each dot is a weather station. Station colour reflects the ' +
            'density of built-up land nearby. Click any dot to open its ' +
            'detail panel.',
          side: 'top',
          align: 'center',
        },
      },

      // ── 14. Zoom controls ───────────────────────────────────────────
      {
        element: '.zoom-controls',
        popover: {
          title: 'Zoom & Locate',
          description:
            'Zoom in and out, or jump to your current location — ' +
            'your coordinates stay on this device and are never sent anywhere.',
          side: 'left',
          align: 'center',
        },
      },

      // ── 15. Data sources ────────────────────────────────────────────
      {
        element: '#sources-btn',
        popover: {
          title: 'Data Sources',
          description:
            'Read about the GHCN-Daily dataset, built-up area data, ' +
            'and other references used in Klymot.',
          side: 'top',
          align: 'end',
        },
      },

      // ── 16. Tour button ─────────────────────────────────────────────
      {
        element: '#tour-btn',
        popover: {
          title: "That\'s It!",
          description: 'You can replay this tour any time by clicking here.',
          side: 'bottom',
          align: 'end',
        },
      },
    ],
  });

  driverObj.drive();
}
