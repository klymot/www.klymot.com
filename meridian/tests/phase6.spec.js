/**
 * Phase 6 acceptance tests — Sources & References Panel
 *
 * Acceptance criteria from IMPLEMENTATION_PLAN.md:
 *   AC1  Button toggles the sources panel open/closed.
 *   AC2  Panel lists all sources and references with correct citations.
 *   AC3  Clicking outside the panel dismisses it.
 *   AC4  Close button dismisses the panel.
 *   AC5  Panel respects the current theme.
 *   AC6  Panel works in both map and table view modes.
 *   AC7  Escape key dismisses the panel.
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
    { id: 'mauna-loa', name: 'Mauna Loa', lat: 19.4721, lng: -155.5922, category: 'observatory', country: 'USA (Hawaii)', elevation_m: 3397, established: 1958, network: 'NOAA GML' },
    { id: 'reykjavik', name: 'Reykjavík', lat: 64.1466, lng: -21.9426,  category: 'station',     country: 'Iceland',      elevation_m:   52, established: 1949, network: 'WMO / GHCN' },
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

async function loadPage(page, { hash = '' } = {}) {
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

  await page.goto(hash ? `/${hash}` : '/');
}

async function waitForMarkers(page, timeout = 3000) {
  await page.waitForFunction(
    () => (window.__mapLayers ?? []).some(l => l.id === 'location-markers'),
    { timeout }
  );
}

/** Click the Data Sources & References button in the footer. */
async function clickSourcesBtn(page) {
  await page.locator('#sources-btn').click();
}

/** Wait for the sources panel to become visible. */
async function waitForPanel(page, timeout = 2000) {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('sources-panel');
      return el && !el.hidden;
    },
    { timeout }
  );
}

// ── AC1: Button toggles the panel open/closed ─────────────────────────────────

test('AC1 – footer sources button exists', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const btn = page.locator('#sources-btn');
  await expect(btn).toBeVisible();
});

test('AC1 – clicking the button opens the sources panel', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const panel = page.locator('#sources-panel');
  await expect(panel).toBeHidden();

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await expect(panel).toBeVisible();
});

test('AC1 – clicking the button again closes the sources panel', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await clickSourcesBtn(page);

  const hidden = await page.evaluate(() => document.getElementById('sources-panel').hidden);
  expect(hidden).toBe(true);
});

test('AC1 – button aria-expanded reflects panel state', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const btn = page.locator('#sources-btn');

  // Initially collapsed.
  await expect(btn).toHaveAttribute('aria-expanded', 'false');

  await clickSourcesBtn(page);
  await waitForPanel(page);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');

  await clickSourcesBtn(page);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

// ── AC2: Panel lists all sources and references ───────────────────────────────

test('AC2 – panel contains Observational Networks section', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('Observational Networks');
});

test('AC2 – panel lists NOAA GML', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('NOAA GML');
});

test('AC2 – panel lists WMO GAW', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('WMO GAW');
});

test('AC2 – panel lists GHCN v4', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('GHCN v4');
});

test('AC2 – panel contains Reanalysis & Gridded Products section', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('Reanalysis');
});

test('AC2 – panel lists ERA5', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('ERA5');
});

test('AC2 – panel lists GISTEMP v4', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('GISTEMP v4');
});

test('AC2 – panel contains Algorithms & Methodology section', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('Algorithms');
});

test('AC2 – panel lists PHA with Menne & Williams 2009 citation', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('PHA');
  expect(text).toContain('Menne');
  expect(text).toContain('2009');
});

test('AC2 – panel lists TOB with Karl et al. 1986 citation', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('TOB');
  expect(text).toContain('Karl');
  expect(text).toContain('1986');
});

test('AC2 – panel lists USHCNv2.5 with Menne et al. 2009 citation', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  const text = await page.locator('#sources-panel').textContent();
  expect(text).toContain('USHCNv2.5');
  expect(text).toContain('2009');
});

// ── AC3: Clicking outside the panel dismisses it ──────────────────────────────

test('AC3 – clicking outside the panel dismisses it', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  // Click on the map area (outside the panel and button).
  await page.locator('#map').click({ position: { x: 100, y: 100 } });

  const hidden = await page.evaluate(() => document.getElementById('sources-panel').hidden);
  expect(hidden).toBe(true);
});

// ── AC4: Close button dismisses the panel ─────────────────────────────────────

test('AC4 – close button dismisses the panel', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await page.locator('.sources-close').click();

  const hidden = await page.evaluate(() => document.getElementById('sources-panel').hidden);
  expect(hidden).toBe(true);
});

// ── AC5: Panel respects the current theme ─────────────────────────────────────

test('AC5 – panel is visible in dark theme', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Ensure dark theme.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await expect(page.locator('#sources-panel')).toBeVisible();
});

test('AC5 – panel is visible in light theme', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Switch to light theme.
  await page.locator('#theme-toggle').click();
  await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'light'
  );

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await expect(page.locator('#sources-panel')).toBeVisible();
});

// ── AC6: Panel works in both map and table view modes ─────────────────────────

test('AC6 – panel opens in map view', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Ensure map view (default).
  const tableVisible = await page.evaluate(() => !document.getElementById('table-container').hidden);
  expect(tableVisible).toBe(false);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await expect(page.locator('#sources-panel')).toBeVisible();
});

test('AC6 – panel opens in table view', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Switch to table view.
  await page.locator('.view-btn[data-view="table"]').click();
  await page.waitForFunction(() => !document.getElementById('table-container').hidden);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await expect(page.locator('#sources-panel')).toBeVisible();
});

// ── AC7: Escape key dismisses the panel ──────────────────────────────────────

test('AC7 – Escape key dismisses the panel', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await clickSourcesBtn(page);
  await waitForPanel(page);

  await page.keyboard.press('Escape');

  const hidden = await page.evaluate(() => document.getElementById('sources-panel').hidden);
  expect(hidden).toBe(true);
});
