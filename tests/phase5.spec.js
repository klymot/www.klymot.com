/**
 * Phase 5 acceptance tests — Table View
 *
 * Acceptance criteria from IMPLEMENTATION_PLAN.md:
 *   AC1  Clicking "Table" in the header switches to a full table of all locations.
 *   AC2  All columns are displayed with correct formatting.
 *   AC3  Virtual scrolling keeps the DOM row count bounded regardless of dataset size.
 *   AC4  Search input filters by name/country/network with result count displayed.
 *   AC5  Clicking any column header sorts the table; clicking again reverses direction.
 *   AC6  Active sort column shows a directional arrow.
 *   AC7  Sort and filter state is reflected in the URL hash.
 *   AC8  Clicking a row opens the detail panel; closing it returns to the table.
 *   AC9  "Show on map" button switches to map view and flies to the location.
 *   AC10 Switching back to Map view restores the map correctly (no hidden map).
 *   AC11 Table respects the current theme.
 *   AC12 Pasting a #table=elevation_m/desc URL opens the table sorted by elevation desc.
 *   AC13 Initial table render from a large dataset completes in <100ms.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BODY  = readFileSync(join(__dirname, 'maplibre-mock.js'), 'utf8');
const EMPTY_CSS  = '';

const MOCK_INDEX = {
  locations: [
    { id: 'mauna-loa',   name: 'Mauna Loa',        lat:  19.4721, lng: -155.5922, category: 'observatory', country: 'USA',         elevation_m: 3397, established: 1958, network: 'GHCNm' },
    { id: 'reykjavik',   name: 'Reykjavík',         lat:  64.1466, lng:  -21.9426, category: 'station',     country: 'Iceland',     elevation_m:   52, established: 1949, network: 'GHCNm' },
    { id: 'south-pole',  name: 'South Pole',        lat: -90.0,    lng:    0.0,    category: 'observatory', country: 'Antarctica',  elevation_m: 2835, established: 1957, network: 'GHCNm' },
    { id: 'cape-grim',   name: 'Cape Grim',         lat: -40.6833, lng:  144.6833, category: 'station',     country: 'Australia',   elevation_m:   94, established: 1976, network: 'GHCNm' },
    { id: 'alert',       name: 'Alert Station',     lat:  82.4953, lng:  -62.3420, category: 'station',     country: 'Canada',      elevation_m:   62, established: 1950, network: 'GHCNm' },
  ],
};

const MOCK_DETAIL_MAUNA_LOA = {
  name:        'Mauna Loa Observatory',
  country:     'USA (Hawaii)',
  elevation:   '3397m',
  established: '1958',
  type:        'High-Elevation Climate Station',
  description: 'High-elevation climate station included in the GHCNm archive.',
  variables:   ['CO₂', 'CH₄'],
  network:     'GHCNm',
};

const QR_MOCK_BODY = `
window.qrcode = function(typeNumber, errorCorrectionLevel) {
  var _data = '';
  return {
    addData: function(data) { _data = data; },
    make:    function() {},
    createSvgTag: function(opts) {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" data-qr-url="' + _data + '"><rect width="100%" height="100%"/></svg>';
    }
  };
};
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadPage(page, { hash = '', detailRoutes = {}, mockIndex = MOCK_INDEX } = {}) {
  await page.route('**maplibre-gl.js**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK_BODY })
  );
  await page.route('**maplibre-gl.css**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: EMPTY_CSS })
  );
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**fonts.gstatic.com**',    route => route.fulfill({ status: 200, body: '' }));
  await page.route('**/data/index.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockIndex) })
  );
  await page.route('**qrcode**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: QR_MOCK_BODY })
  );

  for (const [id, data] of Object.entries(detailRoutes)) {
    const pattern = `**/data/locations/${id}.json`;
    if (data === null) {
      await page.route(pattern, route => route.fulfill({ status: 404, body: 'Not Found' }));
    } else {
      const body = JSON.stringify(data);
      await page.route(pattern, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body })
      );
    }
  }

  await page.goto(hash ? `/${hash}` : '/');
}

/** Wait for the markers layer to appear (index.json fetched and processed). */
async function waitForMarkers(page, timeout = 3000) {
  await page.waitForFunction(
    () => (window.__mapLayers ?? []).some(l => l.id === 'location-markers'),
    { timeout }
  );
}

/** Click the "Table" view button and wait for the table container to appear. */
async function switchToTable(page) {
  await page.locator('.view-btn[data-view="table"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('table-container');
    return el && !el.hidden;
  }, { timeout: 2000 });
}

/** Switch back to map view by clicking the Mercator button. */
async function switchToMap(page) {
  await page.locator('.view-btn[data-view="mercator"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('table-container');
    return el && el.hidden;
  }, { timeout: 2000 });
}

/** Wait for at least one data row to appear in the tbody. */
async function waitForRows(page, timeout = 2000) {
  await page.waitForSelector('tr.station-row', { timeout });
}

// ── AC1: Switching to table view ─────────────────────────────────────────────

test('AC1 – Mercator, Globe and Table view buttons are present', async ({ page }) => {
  await loadPage(page);
  expect(await page.locator('.view-btn[data-view="mercator"]').count()).toBe(1);
  expect(await page.locator('.view-btn[data-view="globe"]').count()).toBe(1);
  expect(await page.locator('.view-btn[data-view="table"]').count()).toBe(1);
});

test('AC1 – clicking "Table" shows the table container', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  const hidden = await page.evaluate(() => document.getElementById('table-container').hidden);
  expect(hidden).toBe(false);
});

test('AC1 – clicking "Table" hides the map container', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  const display = await page.evaluate(() =>
    document.getElementById('map').style.display
  );
  expect(display).toBe('none');
});

test('AC1 – in table view the Table button is active and Mercator/Globe are not', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  const tableActive   = await page.locator('.view-btn[data-view="table"]').evaluate(el => el.classList.contains('active'));
  const mercatorActive = await page.locator('.view-btn[data-view="mercator"]').evaluate(el => el.classList.contains('active'));
  const globeActive    = await page.locator('.view-btn[data-view="globe"]').evaluate(el => el.classList.contains('active'));
  expect(tableActive).toBe(true);
  expect(mercatorActive).toBe(false);
  expect(globeActive).toBe(false);
});

test('AC1 – table rows are rendered for every location', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const rowCount = await page.locator('tr.station-row').count();
  expect(rowCount).toBeGreaterThanOrEqual(MOCK_INDEX.locations.length);
});

// ── AC2: Column content and formatting ───────────────────────────────────────

test('AC2 – station IDs appear in the ID column', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const ids = await page.locator('tr.station-row .col-id').allTextContents();
  expect(ids).toContain('mauna-loa');
  expect(ids).toContain('reykjavik');
});

test('AC2 – station names appear in the Name column', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const names = await page.locator('tr.station-row .col-name-text').allTextContents();
  expect(names.map(n => n.trim())).toContain('Mauna Loa');
  expect(names.map(n => n.trim())).toContain('Reykjavík');
});

test('AC2 – "show on map" button is inside the name column cell', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // The map button must be a descendant of the second <td> (name cell).
  const btnInNameCell = await page.locator('tr.station-row td:nth-child(2) .show-on-map-btn').count();
  expect(btnInNameCell).toBeGreaterThan(0);
});

test('AC2 – latitude is formatted with N/S suffix', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const latCells = await page.locator('tr.station-row td.col-numeric').allTextContents();
  const hasNorth = latCells.some(t => /\d+\.\d+°N/.test(t));
  const hasSouth = latCells.some(t => /\d+\.\d+°S/.test(t));
  expect(hasNorth).toBe(true);
  expect(hasSouth).toBe(true);
});

test('AC2 – elevation is formatted with m suffix', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const cells = await page.locator('tr.station-row td').allTextContents();
  expect(cells.some(t => t.endsWith('m'))).toBe(true);
});

test('AC2 – each row has a "Show on map" button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const btnCount = await page.locator('tr.station-row .show-on-map-btn').count();
  expect(btnCount).toBe(MOCK_INDEX.locations.length);
});

// ── AC3: Virtual scrolling ────────────────────────────────────────────────────

test('AC3 – DOM row count is bounded with a large dataset', async ({ page }) => {
  // Build a 500-row dataset.
  const bigIndex = {
    locations: Array.from({ length: 500 }, (_, i) => ({
      id:          `station-${i}`,
      name:        `Station ${String(i).padStart(3, '0')}`,
      lat:         (i % 180) - 90,
      lng:         (i % 360) - 180,
      category:    i % 2 === 0 ? 'observatory' : 'station',
      country:     `Country ${i % 20}`,
      elevation_m: i * 10,
      established: 1900 + (i % 100),
      network:     `Net ${i % 5}`,
    })),
  };

  await loadPage(page, { mockIndex: bigIndex });
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // At a normal viewport height we expect far fewer rows in DOM than 500.
  const domRowCount = await page.locator('tr.station-row').count();
  expect(domRowCount).toBeLessThan(500);
  expect(domRowCount).toBeGreaterThan(0);
});

// ── AC4: Search / filter (driven by header search bar) ───────────────────────

test('AC4 – header search input is present', async ({ page }) => {
  await loadPage(page);
  const count = await page.locator('#station-search-input').count();
  expect(count).toBe(1);
});

test('AC4 – typing in header search filters table by name', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForTimeout(200); // debounce

  const rows = await page.locator('tr.station-row').count();
  expect(rows).toBe(1);
});

test('AC4 – filter matches on station ID', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.fill('#station-search-input', 'reykjavik');
  await page.waitForTimeout(200);

  const rows = await page.locator('tr.station-row').count();
  expect(rows).toBe(1);
  const name = await page.locator('tr.station-row .col-name-text').textContent();
  expect(name.trim()).toContain('Reykjavík');
});

test('AC4 – filter matches on station name prefix', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // 'Cape' matches only Cape Grim; 'South' matches only South Pole
  await page.fill('#station-search-input', 'Cape');
  await page.waitForTimeout(200);
  const rows = await page.locator('tr.station-row').count();
  expect(rows).toBe(1);

  await page.fill('#station-search-input', 'South');
  await page.waitForTimeout(200);
  const rows2 = await page.locator('tr.station-row').count();
  expect(rows2).toBeGreaterThanOrEqual(1);
});

test('AC4 – result count shows "X of Y stations" when filtered', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForTimeout(200);

  const countText = await page.locator('#table-count').textContent();
  expect(countText).toMatch(/1.*of.*5/);
});

test('AC4 – result count shows total when filter is cleared', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForTimeout(200);
  await page.fill('#station-search-input', '');
  await page.waitForTimeout(200);

  const countText = await page.locator('#table-count').textContent();
  expect(countText).toContain('5');
  expect(countText).not.toMatch(/of/);
});

// ── AC5: Sorting ──────────────────────────────────────────────────────────────

test('AC5 – clicking Elevation header sorts by elevation desc (default dir)', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  // After clicking elevation (default desc), Mauna Loa (3397m) should be first.
  const firstRow = await page.locator('tr.station-row').first();
  const firstName = await firstRow.locator('td:nth-child(2)').textContent();
  expect(firstName).toContain('Mauna Loa');
});

test('AC5 – clicking the same header again reverses direction', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // First click: desc (highest elevation first)
  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  // Second click: asc (lowest elevation first)
  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  const firstRow = await page.locator('tr.station-row').first();
  const firstName = await firstRow.locator('td:nth-child(2)').textContent();
  // Reykjavík (52m) or Cape Grim (94m) should be at the top
  expect(['Reykjavík', 'Alert Station'].some(n => firstName?.includes(n))).toBe(true);
});

test('AC5 – default sort is Name ascending', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // No click needed — Name asc is the default.
  const names = await page.locator('tr.station-row td:nth-child(2)').allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});

// ── AC6: Sort arrow indicator ─────────────────────────────────────────────────

test('AC6 – sorted column header shows ▲ for ascending', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // Name column is sorted ascending by default.
  const nameHeader = await page.locator('th[data-col="name"]').textContent();
  expect(nameHeader).toContain('▲');
});

test('AC6 – sorted column header shows ▼ for descending', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // Elevation defaults to desc on first click.
  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  const elevHeader = await page.locator('th[data-col="elevation_m"]').textContent();
  expect(elevHeader).toContain('▼');
});

test('AC6 – only the active sort column shows an arrow', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  const nameHeader = await page.locator('th[data-col="name"]').textContent();
  expect(nameHeader).not.toContain('▲');
  expect(nameHeader).not.toContain('▼');
});

test('AC6 – sorted column header has col-sorted class', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const hasSortedClass = await page.locator('th[data-col="name"]').evaluate(el =>
    el.classList.contains('col-sorted')
  );
  expect(hasSortedClass).toBe(true);
});

// ── AC7: URL hash ─────────────────────────────────────────────────────────────

test('AC7 – switching to table view sets #table= hash', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#table=/);
});

test('AC7 – default table hash includes sort column and direction', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#table=name/asc');
});

test('AC7 – clicking a column header updates the URL hash', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('th[data-col="elevation_m"]').click();
  await page.waitForTimeout(100);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#table=elevation_m/desc');
});

test('AC7 – toggling direction updates hash direction', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('th[data-col="elevation_m"]').click(); // desc
  await page.locator('th[data-col="elevation_m"]').click(); // asc
  await page.waitForTimeout(100);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#table=elevation_m/asc');
});

// ── AC8: Row click → detail panel → close → return to table ──────────────────

test('AC8 – clicking a row opens the detail panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  const row = page.locator('tr[data-id="mauna-loa"]');
  await row.click();

  await page.waitForFunction(
    () => !document.getElementById('detail-overlay').hidden,
    { timeout: 2000 }
  );

  const overlayVisible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(overlayVisible).toBe(true);
});

test('AC8 – URL hash updates to #station= when row is clicked', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('tr[data-id="mauna-loa"]').click();
  await page.waitForFunction(
    () => window.location.hash.startsWith('#station='),
    { timeout: 2000 }
  );

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#station=mauna-loa');
});

test('AC8 – closing the detail panel returns to the table view', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('tr[data-id="mauna-loa"]').click();
  await page.waitForSelector('.detail-close', { timeout: 2000 });
  await page.locator('.detail-close').click();

  await page.waitForFunction(
    () => !document.getElementById('table-container').hidden,
    { timeout: 2000 }
  );

  const tableVisible = await page.evaluate(() => !document.getElementById('table-container').hidden);
  expect(tableVisible).toBe(true);
});

test('AC8 – closing the detail panel restores the #table= hash', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('tr[data-id="mauna-loa"]').click();
  await page.waitForSelector('.detail-close', { timeout: 2000 });
  await page.locator('.detail-close').click();

  await page.waitForFunction(
    () => window.location.hash.startsWith('#table='),
    { timeout: 2000 }
  );

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#table=/);
});

// ── AC9: "Show on map" button ─────────────────────────────────────────────────

test('AC9 – "Show on map" hides the table and shows the map', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('tr[data-id="mauna-loa"] .show-on-map-btn').click();

  await page.waitForFunction(
    () => document.getElementById('table-container').hidden,
    { timeout: 2000 }
  );

  const tableHidden = await page.evaluate(() => document.getElementById('table-container').hidden);
  expect(tableHidden).toBe(true);

  const mapDisplay = await page.evaluate(() => document.getElementById('map').style.display);
  expect(mapDisplay).not.toBe('none');
});

test('AC9 – "Show on map" does not open the detail panel', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  await page.locator('tr[data-id="mauna-loa"] .show-on-map-btn').click();
  await page.waitForTimeout(300);

  const overlayHidden = await page.evaluate(() => document.getElementById('detail-overlay').hidden);
  expect(overlayHidden).toBe(true);
});

// ── AC10: Switching back to map view ─────────────────────────────────────────

test('AC10 – clicking Mercator button from table hides the table', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await switchToMap(page);

  const tableHidden = await page.evaluate(() => document.getElementById('table-container').hidden);
  expect(tableHidden).toBe(true);
});

test('AC10 – switching to map restores a #map= URL hash', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await switchToMap(page);

  await page.waitForFunction(
    () => window.location.hash.startsWith('#map='),
    { timeout: 2000 }
  );

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#map=/);
});

test('AC10 – switching to map activates the Mercator button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await switchToMap(page);

  const mercatorActive = await page.locator('.view-btn[data-view="mercator"]').evaluate(el =>
    el.classList.contains('active')
  );
  const tableActive = await page.locator('.view-btn[data-view="table"]').evaluate(el =>
    el.classList.contains('active')
  );
  expect(mercatorActive).toBe(true);
  expect(tableActive).toBe(false);
});

// ── AC11: Theme ───────────────────────────────────────────────────────────────

test('AC11 – table is visible in light theme', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.locator('#theme-toggle').click();
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(theme).toBe('light');

  await switchToTable(page);
  await waitForRows(page);

  const rowCount = await page.locator('tr.station-row').count();
  expect(rowCount).toBeGreaterThan(0);
});

test('AC11 – table container inherits data-theme from html element', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);

  // The table inherits theme from the root element.
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(['dark', 'light']).toContain(theme);
});

// ── AC12: URL-initiated table view ────────────────────────────────────────────

test('AC12 – loading #table=name/asc opens the table', async ({ page }) => {
  await loadPage(page, { hash: '#table=name/asc' });
  await waitForMarkers(page);

  await page.waitForFunction(
    () => !document.getElementById('table-container').hidden,
    { timeout: 3000 }
  );

  const hidden = await page.evaluate(() => document.getElementById('table-container').hidden);
  expect(hidden).toBe(false);
});

test('AC12 – loading #table=elevation_m/desc sorts by elevation descending', async ({ page }) => {
  await loadPage(page, { hash: '#table=elevation_m/desc' });
  await waitForMarkers(page);

  await page.waitForSelector('tr.station-row', { timeout: 3000 });

  // Mauna Loa (3397m) should be first row.
  const firstName = await page.locator('tr.station-row td:nth-child(2)').first().textContent();
  expect(firstName).toContain('Mauna Loa');
});

test('AC12 – loading #table=established/asc sorts by established year ascending', async ({ page }) => {
  await loadPage(page, { hash: '#table=established/asc' });
  await waitForMarkers(page);

  await page.waitForSelector('tr.station-row', { timeout: 3000 });

  // Reykjavík (1949) should be first row.
  const firstName = await page.locator('tr.station-row td:nth-child(2)').first().textContent();
  expect(firstName).toContain('Reykjavík');
});

// ── AC13: Performance ─────────────────────────────────────────────────────────

test('AC13 – initial table render for 1000 rows completes in <100ms', async ({ page }) => {
  const bigIndex = {
    locations: Array.from({ length: 1000 }, (_, i) => ({
      id:          `station-${i}`,
      name:        `Station ${String(i).padStart(4, '0')}`,
      lat:         (i % 180) - 90,
      lng:         (i % 360) - 180,
      category:    i % 2 === 0 ? 'observatory' : 'station',
      country:     `Country ${i % 30}`,
      elevation_m: i * 3,
      established: 1900 + (i % 120),
      network:     `Network ${i % 8}`,
    })),
  };

  await loadPage(page, { mockIndex: bigIndex });
  await waitForMarkers(page);

  const elapsed = await page.evaluate(async () => {
    const { showTable, initTableView } = await import('/js/table-view.js');
    // initTableView already called by app; just measure showTable timing.
    const t0 = performance.now();
    showTable({ sortColumn: 'name', sortDirection: 'asc', syncUrl: false });
    return performance.now() - t0;
  });

  expect(elapsed).toBeLessThan(100);
});

// ── Station search (header autocomplete) ─────────────────────────────────────

test('Station search – input is present in the header', async ({ page }) => {
  await loadPage(page);
  expect(await page.locator('#station-search-input').count()).toBe(1);
});

test('Station search – typing a name shows a dropdown with matching stations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'mauna');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });

  const items = await page.locator('#station-dropdown .station-option').count();
  expect(items).toBeGreaterThan(0);

  // Dropdown shows "id: name" grouped in .option-label — verify both parts.
  const labelText = await page.locator('#station-dropdown .option-label').first().textContent();
  expect(labelText).toContain('mauna-loa');
  expect(labelText).toContain('Mauna Loa');
});

test('Station search – typing an ID substring shows matching station', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'south');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });

  const names = await page.locator('#station-dropdown .option-name').allTextContents();
  expect(names.some(n => n.includes('South Pole'))).toBe(true);
});

test('Station search – empty query hides the dropdown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'mauna');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });

  await page.fill('#station-search-input', '');
  const hidden = await page.evaluate(() => document.getElementById('station-dropdown').hidden);
  expect(hidden).toBe(true);
});

test('Station search – selecting a result in map view opens detail after moveend+debounce', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });

  await page.locator('#station-dropdown .station-option').first().click();

  // Panel should NOT be visible immediately — it waits for moveend + 300ms debounce.
  const immediatelyVisible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(immediatelyVisible).toBe(false);

  // After moveend fires (mock: ~20ms) + 300ms debounce the panel should open.
  await page.waitForFunction(() => !document.getElementById('detail-overlay').hidden, { timeout: 2000 });
  const overlayVisible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(overlayVisible).toBe(true);
});

test('Station search – selecting in map view clears the input and closes dropdown', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });
  await page.locator('#station-dropdown .station-option').first().click();

  const inputValue = await page.locator('#station-search-input').inputValue();
  const dropdownHidden = await page.evaluate(() => document.getElementById('station-dropdown').hidden);
  expect(inputValue).toBe('');
  expect(dropdownHidden).toBe(true);
});

test('Station search – typing in table view filters the table directly (no dropdown)', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);

  // In table mode, typing goes straight to table filter; no dropdown shown.
  await page.fill('#station-search-input', 'Cape');
  await page.waitForTimeout(300); // debounce

  const dropdownHidden = await page.evaluate(() => document.getElementById('station-dropdown').hidden);
  expect(dropdownHidden).toBe(true);

  const rows = await page.locator('tr.station-row').count();
  expect(rows).toBe(1);
  const name = await page.locator('tr.station-row td:nth-child(2)').textContent();
  expect(name).toContain('Cape Grim');
});

test('Station search – Escape key closes dropdown and clears input', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.fill('#station-search-input', 'Mauna');
  await page.waitForFunction(() => !document.getElementById('station-dropdown').hidden, { timeout: 1500 });

  await page.locator('#station-search-input').press('Escape');

  const hidden = await page.evaluate(() => document.getElementById('station-dropdown').hidden);
  const value  = await page.locator('#station-search-input').inputValue();
  expect(hidden).toBe(true);
  expect(value).toBe('');
});
