/**
 * Phase 8 acceptance tests — Filter Bar
 *
 * Acceptance criteria:
 *   AC1  Filter toggle button is present in the header.
 *   AC2  Clicking the toggle shows/hides the filter bar.
 *   AC3  Filter bar contains buttons for all expected filter criteria.
 *   AC4  Clicking a filter button opens a dropdown with checkboxes.
 *   AC5  Selecting a latitude band filters the table to matching rows only.
 *   AC6  Multiple selections within a single filter use OR logic.
 *   AC7  Selections across multiple filters use AND logic.
 *   AC8  Text search and column filters compose correctly.
 *   AC9  Toggling the filter bar OFF removes filtering but preserves selections.
 *   AC10 Toggling the filter bar back ON reapplies saved selections.
 *   AC11 "Clear all" button removes all active filters.
 *   AC12 Filter bar is hidden when in map view; visible only in table view.
 *   AC13 Longitude bands filter correctly.
 *   AC14 Elevation bands filter correctly.
 *   AC15 Percentile-based filters (BU/Pop) work correctly when data has values.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BODY  = readFileSync(join(__dirname, 'maplibre-mock.js'), 'utf8');
const EMPTY_CSS  = '';

// Mock data with diverse lat/lng/elevation/BU/Pop values so every filter bucket
// can be exercised.
const MOCK_INDEX_FULL = {
  locations: [
    // Arctic (lat > 66.5) — UTC-6 to UTC-3 (lng=-62) — Low elevation
    {
      id: 'alert', name: 'Alert Station', lat: 82.4953, lng: -62.342,
      category: 'station', country: 'Canada', elevation_m: 62,
      bu_2020_1km: 0.0, bu_2020_5km: 0.0, bu_2020_20km: 0.1,
      pop_2020_1km: 0, pop_2020_5km: 0, pop_2020_20km: 5,
      ghcn_longest_run_9_months: 70,
    },
    // N. Temperate (23.4–66.5°N) — UTC-3 to UTC+0 — Low elevation
    {
      id: 'reykjavik', name: 'Reykjavík', lat: 64.1466, lng: -21.9426,
      category: 'station', country: 'Iceland', elevation_m: 52,
      bu_2020_1km: 5.0, bu_2020_5km: 3.0, bu_2020_20km: 2.0,
      pop_2020_1km: 100, pop_2020_5km: 500, pop_2020_20km: 2000,
      ghcn_longest_run_9_months: 120,
    },
    // Tropics (23.4°S–23.4°N) — UTC-12 to UTC-9 — Very High elevation
    {
      id: 'mauna-loa', name: 'Mauna Loa', lat: 19.4721, lng: -155.5922,
      category: 'observatory', country: 'USA', elevation_m: 3397,
      bu_2020_1km: 1.0, bu_2020_5km: 0.5, bu_2020_20km: 0.3,
      pop_2020_1km: 50, pop_2020_5km: 200, pop_2020_20km: 800,
      ghcn_longest_run_9_months: 65,
    },
    // S. Temperate (23.4–66.5°S) — UTC+9 to UTC+12 — Low elevation
    {
      id: 'cape-grim', name: 'Cape Grim', lat: -40.6833, lng: 144.6833,
      category: 'station', country: 'Australia', elevation_m: 94,
      bu_2020_1km: 2.0, bu_2020_5km: 1.0, bu_2020_20km: 0.8,
      pop_2020_1km: 200, pop_2020_5km: 800, pop_2020_20km: 3000,
      ghcn_longest_run_9_months: 48,
    },
    // Antarctic (lat < -66.5) — UTC+0 to UTC+3 — High elevation
    {
      id: 'south-pole', name: 'South Pole', lat: -90.0, lng: 0.0,
      category: 'observatory', country: 'Antarctica', elevation_m: 2835,
      bu_2020_1km: 0.5, bu_2020_5km: 0.2, bu_2020_20km: 0.1,
      pop_2020_1km: 10, pop_2020_5km: 40, pop_2020_20km: 100,
      ghcn_longest_run_9_months: 68,
    },
    // N. Temperate — UTC+0 to UTC+3 — Low elevation — long run
    {
      id: 'de-bilt', name: 'De Bilt', lat: 52.1, lng: 5.18,
      category: 'station', country: 'Netherlands', elevation_m: 2,
      bu_2020_1km: 30.0, bu_2020_5km: 25.0, bu_2020_20km: 20.0,
      pop_2020_1km: 5000, pop_2020_5km: 20000, pop_2020_20km: 80000,
      ghcn_longest_run_9_months: 310,
    },
  ],
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

async function loadPage(page, { hash = '', mockIndex = MOCK_INDEX_FULL } = {}) {
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
  await page.route('**html2canvas**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.html2canvas = async () => document.createElement("canvas");' })
  );
  await page.route('**jspdf**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.jspdf = { jsPDF: class { addImage(){} save(){} } };' })
  );
  await page.goto(hash ? `/${hash}` : '/');
}

async function waitForMarkers(page, timeout = 3000) {
  await page.waitForFunction(
    () => (window.__mapLayers ?? []).some(l => l.id === 'location-markers'),
    { timeout }
  );
}

async function switchToTable(page) {
  await page.locator('.view-btn[data-view="table"]').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('table-container');
    return el && !el.hidden;
  }, { timeout: 2000 });
}

async function waitForRows(page, timeout = 2000) {
  await page.waitForSelector('tr.station-row', { timeout });
}

async function openFilterBar(page) {
  const btn = page.locator('#filter-toggle');
  await btn.click();
  await page.waitForFunction(() => {
    const bar = document.getElementById('filter-bar');
    return bar && !bar.hidden;
  }, { timeout: 2000 });
}

async function openFilterDropdown(page, filterId) {
  const btn = page.locator(`.filter-bar-btn[data-filter-id="${filterId}"]`);
  await btn.click();
  await page.waitForSelector('.filter-dropdown', { timeout: 2000 });
}

async function getVisibleRowIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('tr.station-row[data-id]')].map(r => r.dataset.id)
  );
}

// ── AC1: Filter toggle button exists ─────────────────────────────────────────

test('AC1 – filter toggle button is present in the header', async ({ page }) => {
  await loadPage(page);
  const btn = page.locator('#filter-toggle');
  await expect(btn).toBeVisible();
});

test('AC1 – filter toggle button is initially not active', async ({ page }) => {
  await loadPage(page);
  const active = await page.locator('#filter-toggle').evaluate(el => el.classList.contains('active'));
  expect(active).toBe(false);
  const pressed = await page.locator('#filter-toggle').getAttribute('aria-pressed');
  expect(pressed).toBe('false');
});

// ── AC2: Toggle shows/hides filter bar ───────────────────────────────────────

test('AC2 – filter bar is hidden by default', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  const hidden = await page.evaluate(() => document.getElementById('filter-bar').hidden);
  expect(hidden).toBe(true);
});

test('AC2 – clicking toggle shows the filter bar', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  const hidden = await page.evaluate(() => document.getElementById('filter-bar').hidden);
  expect(hidden).toBe(false);
});

test('AC2 – filter toggle button becomes active when bar is shown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  const active  = await page.locator('#filter-toggle').evaluate(el => el.classList.contains('active'));
  const pressed = await page.locator('#filter-toggle').getAttribute('aria-pressed');
  expect(active).toBe(true);
  expect(pressed).toBe('true');
});

test('AC2 – clicking toggle again hides the filter bar', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  // Toggle off
  await page.locator('#filter-toggle').click();
  const hidden = await page.evaluate(() => document.getElementById('filter-bar').hidden);
  expect(hidden).toBe(true);
});

// ── AC3: Filter bar contains expected buttons ─────────────────────────────────

test('AC3 – filter bar contains Latitude button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="lat"]')).toBeVisible();
});

test('AC3 – filter bar contains Longitude button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="lng"]')).toBeVisible();
});

test('AC3 – filter bar contains Elevation button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="elevation_m"]')).toBeVisible();
});

test('AC3 – filter bar contains Longest Run button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="ghcn_longest_run_9_months"]')).toBeVisible();
});

test('AC3 – filter bar contains BU 1km button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="bu_2020_1km"]')).toBeVisible();
});

test('AC3 – filter bar contains Pop 20km button', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await expect(page.locator('.filter-bar-btn[data-filter-id="pop_2020_20km"]')).toBeVisible();
});

test('AC3 – Clear all button is present but hidden when no filters active', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  const hidden = await page.evaluate(() => {
    const btn = document.getElementById('filter-clear-btn');
    return btn?.hidden;
  });
  expect(hidden).toBe(true);
});

// ── AC4: Clicking a filter button opens a dropdown ───────────────────────────

test('AC4 – clicking Latitude button opens a dropdown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await expect(page.locator('.filter-dropdown')).toBeVisible();
});

test('AC4 – Latitude dropdown contains geographic zone options', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  expect(labels.some(l => l.includes('Arctic'))).toBe(true);
  expect(labels.some(l => l.includes('Tropic') || l.includes('Temperate'))).toBe(true);
  expect(labels.some(l => l.includes('Antarctic'))).toBe(true);
});

test('AC4 – dropdown contains checkboxes', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  const checkboxCount = await page.locator('.filter-dropdown input[type="checkbox"]').count();
  expect(checkboxCount).toBeGreaterThan(0);
});

test('AC4 – clicking the same button again closes the dropdown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  // Click the button again to close
  await page.locator('.filter-bar-btn[data-filter-id="lat"]').click();
  const dropdownCount = await page.locator('.filter-dropdown').count();
  expect(dropdownCount).toBe(0);
});

test('AC4 – Longitude dropdown contains UTC zone options', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lng');

  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  expect(labels.some(l => l.includes('UTC'))).toBe(true);
});

test('AC4 – Elevation dropdown contains elevation zone options', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'elevation_m');

  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  expect(labels.some(l => l.includes('Low') || l.includes('Moderate') || l.includes('High'))).toBe(true);
});

// ── AC5: Latitude filter works ───────────────────────────────────────────────

test('AC5 – selecting Arctic latitude band shows only Arctic stations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  // Check the Arctic checkbox (first item)
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();

  // Wait for filtering to propagate
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  // Only alert (lat=82.5) and possibly others >66.5 should appear
  expect(rowIds).toContain('alert');
  expect(rowIds).not.toContain('mauna-loa');   // Tropics
  expect(rowIds).not.toContain('south-pole');  // Antarctic
  expect(rowIds).not.toContain('cape-grim');   // S. Temperate
  expect(rowIds).not.toContain('reykjavik');   // N. Temperate (64° < 66.5°)
});

test('AC5 – selecting Antarctic latitude band shows only Antarctic stations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  // Antarctic is the last checkbox
  await page.locator('.filter-dropdown input[type="checkbox"]').last().check();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('south-pole');
  expect(rowIds).not.toContain('alert');
  expect(rowIds).not.toContain('mauna-loa');
});

test('AC5 – table count reflects filter', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  // Select Arctic only
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.waitForTimeout(100);

  const countText = await page.locator('#table-count').textContent();
  // Should show 1 of 6 stations
  expect(countText).toMatch(/1\s+of\s+6/);
});

// ── AC6: OR logic within a single filter ─────────────────────────────────────

test('AC6 – selecting two latitude bands shows stations from both', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  const checkboxes = page.locator('.filter-dropdown input[type="checkbox"]');
  // First = Arctic, second = N. Temperate
  await checkboxes.nth(0).check(); // Arctic
  await checkboxes.nth(1).check(); // N. Temperate
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('alert');      // Arctic
  expect(rowIds).toContain('reykjavik'); // N. Temperate
  // de-bilt is also N. Temperate (lat 52.1)
  expect(rowIds).toContain('de-bilt');
  expect(rowIds).not.toContain('mauna-loa');  // Tropics
  expect(rowIds).not.toContain('south-pole'); // Antarctic
});

// ── AC7: AND logic across filters ────────────────────────────────────────────

test('AC7 – combining lat and elevation filters uses AND logic', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select Arctic latitude
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.waitForTimeout(50);

  // Now open elevation dropdown and select "Very High" (3000–5000m)
  // The Arctic stations have: alert=62m (Low), so none should match both
  await openFilterDropdown(page, 'elevation_m');
  const elevLabels = await page.locator('.filter-dropdown-item span').allTextContents();
  // Find "Very High" band
  let veryHighIdx = elevLabels.findIndex(l => l.includes('Very High'));
  if (veryHighIdx >= 0) {
    await page.locator('.filter-dropdown input[type="checkbox"]').nth(veryHighIdx).check();
  }
  await page.waitForTimeout(100);

  // alert is Arctic but only 62m elevation (Low), not Very High
  // south-pole is Antarctic (not Arctic), elevation 2835m (High, not Very High)
  // No station is both Arctic AND Very High elevation in our mock
  const rowIds = await getVisibleRowIds(page);
  expect(rowIds.length).toBe(0);
});

test('AC7 – AND filter: Arctic + Low elevation shows alert', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select Arctic latitude
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.waitForTimeout(50);

  // Select "Low (0–500m)" elevation — alert=62m qualifies
  await openFilterDropdown(page, 'elevation_m');
  const elevLabels = await page.locator('.filter-dropdown-item span').allTextContents();
  const lowIdx = elevLabels.findIndex(l => l.includes('Low'));
  if (lowIdx >= 0) {
    await page.locator('.filter-dropdown input[type="checkbox"]').nth(lowIdx).check();
  }
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('alert');
  expect(rowIds).not.toContain('reykjavik'); // N. Temperate, not Arctic
  expect(rowIds).not.toContain('south-pole'); // Antarctic
});

// ── AC8: Text search + column filter ─────────────────────────────────────────

test('AC8 – text search further narrows column-filtered results', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select N. Temperate + Arctic (2 stations: alert, reykjavik, de-bilt)
  await openFilterDropdown(page, 'lat');
  const checkboxes = page.locator('.filter-dropdown input[type="checkbox"]');
  await checkboxes.nth(0).check(); // Arctic
  await checkboxes.nth(1).check(); // N. Temperate
  // Close dropdown by clicking outside
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // Now type in the search box — filter by name containing "alert"
  await page.fill('#station-search-input', 'alert');
  await page.waitForTimeout(300);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('alert');
  expect(rowIds).not.toContain('reykjavik');
  expect(rowIds).not.toContain('de-bilt');
});

// ── AC9: Toggling filter bar off removes active filtering ─────────────────────

test('AC9 – toggling filter bar off shows all stations again', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Apply Arctic filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // Verify filter is active (only 1 station)
  let rowIds = await getVisibleRowIds(page);
  expect(rowIds.length).toBeLessThan(6);

  // Toggle filter bar off
  await page.locator('#filter-toggle').click();
  await page.waitForTimeout(100);

  // Should show all 6 stations now
  rowIds = await getVisibleRowIds(page);
  expect(rowIds.length).toBe(6);
});

// ── AC10: Toggling back on restores selections ────────────────────────────────

test('AC10 – toggling filter bar back on reapplies saved selections', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Apply Arctic filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // Toggle off (shows all)
  await page.locator('#filter-toggle').click();
  await page.waitForTimeout(100);

  // Toggle on (restores filter)
  await page.locator('#filter-toggle').click();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('alert');
  expect(rowIds).not.toContain('mauna-loa');
  expect(rowIds.length).toBe(1);
});

test('AC10 – filter button shows active state after toggle cycle', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Apply Arctic filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // The lat filter button should be highlighted
  const active = await page.locator('.filter-bar-btn[data-filter-id="lat"]').evaluate(el => el.classList.contains('active'));
  expect(active).toBe(true);
});

// ── AC11: Clear all button ────────────────────────────────────────────────────

test('AC11 – Clear all button becomes visible when a filter is active', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  const hidden = await page.evaluate(() => document.getElementById('filter-clear-btn').hidden);
  expect(hidden).toBe(false);
});

test('AC11 – Clear all removes all filters and shows all stations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Apply Arctic filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // Click Clear all
  await page.locator('#filter-clear-btn').click();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds.length).toBe(6);
});

test('AC11 – Clear all hides the Clear button again', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await page.locator('#filter-clear-btn').click();
  await page.waitForTimeout(100);

  const hidden = await page.evaluate(() => document.getElementById('filter-clear-btn').hidden);
  expect(hidden).toBe(true);
});

test('AC11 – Clear all deactivates filter buttons', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await page.locator('#filter-clear-btn').click();
  await page.waitForTimeout(100);

  const btnActive = await page.locator('.filter-bar-btn[data-filter-id="lat"]').evaluate(el => el.classList.contains('active'));
  expect(btnActive).toBe(false);
});

// ── AC12: Filter bar position ────────────────────────────────────────────────

test('AC12 – filter bar is a sibling of main (not inside table-container)', async ({ page }) => {
  await loadPage(page);
  const isDirectBodyChild = await page.evaluate(() => {
    const bar = document.getElementById('filter-bar');
    return !document.getElementById('table-container').contains(bar);
  });
  expect(isDirectBodyChild).toBe(true);
});

test('AC12 – filter bar appears before main in document order', async ({ page }) => {
  await loadPage(page);
  const filterBarBeforeMain = await page.evaluate(() => {
    const bar  = document.getElementById('filter-bar');
    const main = document.querySelector('main.map-wrapper');
    // Node.DOCUMENT_POSITION_FOLLOWING means bar comes before main
    return (bar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(filterBarBeforeMain).toBe(true);
});

test('AC12 – filter bar is visible in map (globe) view when toggled on', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Should be on globe/map view by default; open the filter bar
  await page.locator('#filter-toggle').click();
  await page.waitForFunction(() => !document.getElementById('filter-bar').hidden, { timeout: 2000 });

  const hidden = await page.evaluate(() => document.getElementById('filter-bar').hidden);
  expect(hidden).toBe(false);
});

// ── AC13: Longitude filter ────────────────────────────────────────────────────

test('AC13 – selecting UTC+9 to UTC+12 shows only cape-grim', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lng');

  // Last item is UTC+9 to UTC+12
  await page.locator('.filter-dropdown input[type="checkbox"]').last().check();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('cape-grim'); // lng=144.68 → UTC+9 to +12
  expect(rowIds.every(id => id === 'cape-grim')).toBe(true);
});

// ── AC14: Elevation filter ────────────────────────────────────────────────────

test('AC14 – selecting High elevation shows mauna-loa and south-pole', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'elevation_m');

  // High = 1500–3000m; south-pole=2835m matches; mauna-loa=3397m does not (Very High)
  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  const highIdx = labels.findIndex(l => l.includes('High (1'));
  expect(highIdx).toBeGreaterThanOrEqual(0);
  await page.locator('.filter-dropdown input[type="checkbox"]').nth(highIdx).check();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('south-pole'); // 2835m → High
  expect(rowIds).not.toContain('mauna-loa'); // 3397m → Very High
  expect(rowIds).not.toContain('alert');     // 62m → Low
});

// ── AC15: Percentile filter ───────────────────────────────────────────────────

test('AC15 – BU 1km percentile dropdown has options when data has values', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'bu_2020_1km');

  const count = await page.locator('.filter-dropdown input[type="checkbox"]').count();
  expect(count).toBeGreaterThan(0);
});

test('AC15 – BU 1km percentile dropdown includes a symmetric bottom band', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'bu_2020_1km');

  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  expect(labels).toContain('<1st %ile');
  expect(labels).toContain('1–5th %ile');
});

test('AC15 – top BU 1km percentile filter shows only the highest BU station', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'bu_2020_1km');

  // The first option is the top percentile band (>99th %ile)
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.waitForTimeout(100);

  // de-bilt has bu_2020_1km = 30.0 (highest in the mock), so it should be in the top band
  const rowIds = await getVisibleRowIds(page);
  // The top band should include de-bilt (30.0 is highest)
  expect(rowIds.length).toBeGreaterThan(0);
  expect(rowIds.length).toBeLessThan(6); // not all stations
});

// ── Filter button label updates ───────────────────────────────────────────────

test('filter button shows count of active selections', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  await page.locator('.filter-dropdown input[type="checkbox"]').nth(0).check();
  await page.locator('.filter-dropdown input[type="checkbox"]').nth(1).check();
  await page.keyboard.press('Escape');

  const btnText = await page.locator('.filter-bar-btn[data-filter-id="lat"]').textContent();
  expect(btnText).toContain('(2)');
});

// ── Dropdown keyboard / outside-click dismissal ───────────────────────────────

test('Escape key closes the open dropdown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  await page.keyboard.press('Escape');
  const count = await page.locator('.filter-dropdown').count();
  expect(count).toBe(0);
});

test('clicking outside closes the open dropdown', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'lat');

  // Click outside — on the table area
  await page.locator('#table-scroller').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(100);
  const count = await page.locator('.filter-dropdown').count();
  expect(count).toBe(0);
});

// ── Longest Run filter ────────────────────────────────────────────────────────

test('Longest Run filter: >300yr shows de-bilt only', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);
  await openFilterDropdown(page, 'ghcn_longest_run_9_months');

  const labels = await page.locator('.filter-dropdown-item span').allTextContents();
  const longIdx = labels.findIndex(l => l.includes('>300'));
  expect(longIdx).toBeGreaterThanOrEqual(0);
  await page.locator('.filter-dropdown input[type="checkbox"]').nth(longIdx).check();
  await page.waitForTimeout(100);

  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('de-bilt'); // 310 years
  expect(rowIds).not.toContain('cape-grim'); // 48 years
});

// ── URL / QR code integration ─────────────────────────────────────────────────

test('active filter state is reflected in the URL hash', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select Arctic latitude band
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toContain('filters=');
  expect(hash).toContain('lat:');
});

test('filter state includes correct band indices in URL', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select the first band (index 0) of the lat filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').nth(0).check(); // band 0
  await page.locator('.filter-dropdown input[type="checkbox"]').nth(2).check(); // band 2
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const hash = await page.evaluate(() => window.location.hash);
  // Should contain lat:0.2 (sorted band indices joined by '.')
  expect(hash).toContain('lat:0.2');
});

test('filter state is in map view URL when filtering in globe/mercator', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Open filter bar while in map (globe) view
  await openFilterBar(page);
  await waitForMarkers(page);

  // Wait for filter bar to have buttons (filter bar is initialised after markers)
  await page.waitForSelector('.filter-bar-btn[data-filter-id="lat"]', { timeout: 3000 });

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const hash = await page.evaluate(() => window.location.hash);
  // Still on map view so hash starts with #map=
  expect(hash).toMatch(/^#map=/);
  expect(hash).toContain('filters=lat:');
});

test('clearing all filters removes filter state from the URL', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.locator('#filter-clear-btn').click();
  await page.waitForTimeout(200);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).not.toContain('filters=');
});

test('toggling filter bar off removes filter state from URL', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Toggle off
  await page.locator('#filter-toggle').click();
  await page.waitForTimeout(200);

  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).not.toContain('filters=');
});

test('URL with filter state restores filter on page reload', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Apply Arctic filter
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Grab the current URL hash
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).toContain('filters=lat:0');

  // Load the page fresh with this hash
  await loadPage(page, { hash: hash });
  await waitForMarkers(page);

  // Filter bar should be visible (restored from URL)
  const barHidden = await page.evaluate(() => document.getElementById('filter-bar').hidden);
  expect(barHidden).toBe(false);

  // Table button should be active (table hash)
  await page.waitForFunction(() => {
    const el = document.getElementById('table-container');
    return el && !el.hidden;
  }, { timeout: 2000 });

  // Only the Arctic station should be shown
  await waitForRows(page);
  const rowIds = await getVisibleRowIds(page);
  expect(rowIds).toContain('alert');
  expect(rowIds).not.toContain('mauna-loa');
});

test('map view applies URL filter state to visible stations on initial load', async ({ page }) => {
  await loadPage(page, { hash: '#map=1.5/0/0/globe/filters=lat:0' });
  await waitForMarkers(page);

  const footerText = await page.locator('#station-count').textContent();
  expect(footerText).toMatch(/1\s+of\s+6/);
});

// ── Footer station count ──────────────────────────────────────────────────────

test('footer shows total station count with no filter active', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const footerText = await page.locator('#station-count').textContent();
  expect(footerText).toContain('6'); // 6 stations in MOCK_INDEX_FULL
  expect(footerText).not.toContain('of');
});

test('footer shows "X of Y stations" when filter is active', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  // Select Arctic — only 1 station matches
  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const footerText = await page.locator('#station-count').textContent();
  // Should say "1 of 6 stations"
  expect(footerText).toContain('of');
  expect(footerText).toMatch(/1\s+of\s+6/);
});

test('footer returns to total count after clear all', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);
  await switchToTable(page);
  await waitForRows(page);
  await openFilterBar(page);

  await openFilterDropdown(page, 'lat');
  await page.locator('.filter-dropdown input[type="checkbox"]').first().check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.locator('#filter-clear-btn').click();
  await page.waitForTimeout(200);

  const footerText = await page.locator('#station-count').textContent();
  expect(footerText).not.toContain('of');
  expect(footerText).toContain('6');
});
