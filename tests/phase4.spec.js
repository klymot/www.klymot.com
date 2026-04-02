/**
 * Phase 4 acceptance tests — Detail Panel Overlay
 *
 * Acceptance criteria from IMPLEMENTATION_PLAN.md:
 *   AC1  Clicking a marker with a detail file shows the overlay with correct data.
 *   AC2  Loading shimmer displays while fetching.
 *   AC3  Clicking a marker without a detail file shows a graceful fallback.
 *   AC4  Overlay closes on backdrop click, × button, and Escape key.
 *   AC5  Panel respects the current theme.
 *   AC6  Panel includes a scannable QR code linking to the station URL.
 *   AC7  Opening the panel updates the URL hash to #station=<id>;
 *        closing the panel restores the map view hash.
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
    { id: 'mauna-loa',  name: 'Mauna Loa',  lat: 19.4721, lng: -155.5922, category: 'observatory', country: 'USA (Hawaii)',    elevation_m: 3397, established: 1958, network: 'NOAA GML' },
    { id: 'reykjavik',  name: 'Reykjavík',  lat: 64.1466, lng: -21.9426,  category: 'station',     country: 'Iceland',        elevation_m: 52,   established: 1949, network: 'WMO / GHCN' },
    { id: 'south-pole', name: 'South Pole', lat: -90.0,   lng: 0.0,       category: 'observatory', country: 'Antarctica',     elevation_m: 2835, established: 1957, network: 'NOAA GML / NSF' },
  ],
};

const MOCK_DETAIL_MAUNA_LOA = {
  name:        'Mauna Loa Observatory',
  country:     'USA (Hawaii)',
  elevation:   '3397m',
  established: '1958',
  type:        'Atmospheric Baseline Observatory',
  description: 'Premier atmospheric research facility operated by NOAA.',
  variables:   ['CO₂', 'CH₄', 'N₂O'],
  network:     'NOAA GML / WMO GAW',
};

// Minimal qrcode-generator mock that stamps data-qr-url on the SVG.
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

/**
 * Load the app with standard mocks.
 * Pass detailRoutes as { locationId: jsonObject|null } to control detail fetches:
 *   - jsonObject  → 200 with JSON body
 *   - null        → 404
 * Locations not listed in detailRoutes will be passed through to the real server.
 */
async function loadPage(page, { hash = '', detailRoutes = {} } = {}) {
  await page.route('**maplibre-gl.js**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK_BODY })
  );
  await page.route('**maplibre-gl.css**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: EMPTY_CSS })
  );
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**fonts.gstatic.com**',    route => route.fulfill({ status: 200, body: '' }));
  await page.route('**/data/index.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INDEX) })
  );
  await page.route('**qrcode**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: QR_MOCK_BODY })
  );

  // Register per-location detail routes.
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

/** Dispatch location:select for a given station id. */
async function selectStation(page, id) {
  await page.evaluate((stationId) => {
    document.dispatchEvent(new CustomEvent('location:select', { detail: { id: stationId } }));
  }, id);
}

/** Wait for the detail overlay to become visible. */
async function waitForOverlay(page, timeout = 2000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('detail-overlay');
      return el && !el.hidden;
    },
    { timeout }
  );
}

// ── AC1: Correct data renders after fetch ─────────────────────────────────────

test('AC1 – opening a station shows the overlay', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  const visible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(visible).toBe(true);
});

test('AC1 – overlay shows the station name', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  await page.waitForSelector('.detail-name', { timeout: 2000 });
  const name = await page.locator('.detail-name').textContent();
  expect(name).toContain('Mauna Loa Observatory');
});

test('AC1 – overlay shows the station type badge', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-category', { timeout: 2000 });
  const category = await page.locator('.detail-category').textContent();
  expect(category).toContain('Atmospheric Baseline Observatory');
});

test('AC1 – overlay shows the metadata grid with country, elevation, established, network', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-meta', { timeout: 2000 });
  const metaText = await page.locator('.detail-meta').textContent();
  expect(metaText).toContain('USA (Hawaii)');
  expect(metaText).toContain('3397m');
  expect(metaText).toContain('1958');
  expect(metaText).toContain('NOAA GML / WMO GAW');
});

test('AC1 – overlay shows variable tags', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.variable-tag', { timeout: 2000 });
  const tags = await page.locator('.variable-tag').allTextContents();
  expect(tags).toContain('CO₂');
  expect(tags).toContain('CH₄');
});

test('AC1 – overlay shows the description', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-description', { timeout: 2000 });
  const desc = await page.locator('.detail-description').textContent();
  expect(desc).toContain('NOAA');
});

// ── AC2: Loading shimmer ──────────────────────────────────────────────────────

test('AC2 – loading shimmer is visible while detail fetch is pending', async ({ page }) => {
  // Register a deferred route: the fetch hangs until we resolve it.
  let resolveRoute;
  await page.route('**/data/locations/mauna-loa.json', route => {
    // Don't fulfil immediately; let the promise sit.
    new Promise(resolve => { resolveRoute = resolve; })
      .then(() => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_DETAIL_MAUNA_LOA),
      }));
  });

  await loadPage(page);
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  // The fetch hasn't resolved yet, so the shimmer should be present.
  const shimmerCount = await page.locator('.detail-loading').count();
  expect(shimmerCount).toBe(1);

  // Resolve the route to avoid hanging the test.
  resolveRoute?.();
});

test('AC2 – shimmer is replaced by content after the fetch resolves', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  // Wait for full data render.
  await page.waitForSelector('.detail-name', { timeout: 2000 });

  const shimmerCount = await page.locator('.detail-loading').count();
  expect(shimmerCount).toBe(0);
});

// ── AC3: Graceful fallback for missing detail file ────────────────────────────

test('AC3 – overlay shows a fallback message when the detail file returns 404', async ({ page }) => {
  // 'ghost-station' has no detail file.
  await loadPage(page, { detailRoutes: { 'ghost-station': null } });
  await waitForMarkers(page);

  await selectStation(page, 'ghost-station');
  await waitForOverlay(page);

  await page.waitForSelector('.detail-name', { timeout: 2000 });
  const name = await page.locator('.detail-name').textContent();
  expect(name?.toLowerCase()).toContain('no data');
});

test('AC3 – fallback panel still shows a close button', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'ghost-station': null } });
  await waitForMarkers(page);

  await selectStation(page, 'ghost-station');
  await waitForOverlay(page);

  await page.waitForSelector('.detail-close', { timeout: 2000 });
  const closeBtnCount = await page.locator('.detail-close').count();
  expect(closeBtnCount).toBe(1);
});

// ── AC4: Panel closes on backdrop, × button, and Escape ──────────────────────

test('AC4 – clicking the × button closes the panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await page.waitForSelector('.detail-close', { timeout: 2000 });

  await page.locator('.detail-close').click();

  const hidden = await page.evaluate(() => document.getElementById('detail-overlay').hidden);
  expect(hidden).toBe(true);
});

test('AC4 – clicking the backdrop closes the panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  // Click the backdrop itself (not the panel inside it).
  await page.locator('#detail-overlay').click({ position: { x: 5, y: 5 } });

  const hidden = await page.evaluate(() => document.getElementById('detail-overlay').hidden);
  expect(hidden).toBe(true);
});

test('AC4 – pressing Escape closes the panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  await page.keyboard.press('Escape');

  const hidden = await page.evaluate(() => document.getElementById('detail-overlay').hidden);
  expect(hidden).toBe(true);
});

test('AC4 – Escape key does nothing when the panel is already closed', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Panel is closed; pressing Escape should not throw.
  await page.keyboard.press('Escape');

  const hidden = await page.evaluate(() => document.getElementById('detail-overlay').hidden);
  expect(hidden).toBe(true);
});

// ── AC5: Panel respects current theme ─────────────────────────────────────────

test('AC5 – panel is present when theme is dark (default)', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(theme).toBe('dark');

  const overlayVisible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(overlayVisible).toBe(true);
});

test('AC5 – panel renders correctly in light theme', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  // Switch to light theme before opening the panel.
  await page.locator('#theme-toggle').click();
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(theme).toBe('light');

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  const overlayVisible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(overlayVisible).toBe(true);

  // Panel content should still render correctly.
  await page.waitForSelector('.detail-name', { timeout: 2000 });
  const name = await page.locator('.detail-name').textContent();
  expect(name).toContain('Mauna Loa Observatory');
});

// ── AC6: Detail panel QR code ─────────────────────────────────────────────────

test('AC6 – a QR code SVG is rendered inside the detail panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-qr .qr-code svg', { timeout: 2000 });
  const svgCount = await page.locator('.detail-qr .qr-code svg').count();
  expect(svgCount).toBe(1);
});

test('AC6 – detail panel QR encodes the station URL (#station=<id>)', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-qr .qr-code svg', { timeout: 2000 });
  const qrUrl = await page.locator('.detail-qr .qr-code svg').getAttribute('data-qr-url');
  expect(qrUrl).toContain('#station=mauna-loa');
});

test('AC6 – detail panel has a "Share this station" label', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');

  await page.waitForSelector('.detail-qr .qr-label', { timeout: 2000 });
  const label = await page.locator('.detail-qr .qr-label').textContent();
  expect(label?.toLowerCase()).toContain('share');
});

// ── AC7: URL hash updates on open and close ───────────────────────────────────

test('AC7 – opening the panel updates the URL hash to #station=<id>', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#station=mauna-loa');
});

test('AC7 – opening the panel for a different station updates hash correctly', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'reykjavik': { name: 'Reykjavík', type: 'Station', country: 'Iceland', elevation: '52m', established: '1949', network: 'WMO', description: 'Test', variables: [] } } });
  await waitForMarkers(page);

  await selectStation(page, 'reykjavik');
  await waitForOverlay(page);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toBe('#station=reykjavik');
});

test('AC7 – closing the panel restores a #map= hash', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  // Trigger a moveend first so the map has a known state in the hash.
  await page.evaluate(() => window.__mapInstance._emit('moveend', {}));
  await page.waitForTimeout(450);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  // Close via × button.
  await page.waitForSelector('.detail-close', { timeout: 2000 });
  await page.locator('.detail-close').click();

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#map=/);
});

test('AC7 – closing via Escape also restores the #map= hash', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  await page.keyboard.press('Escape');

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toMatch(/^#map=/);
});
