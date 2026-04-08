/**
 * Phase 7 acceptance tests — Polish & Responsive
 *
 * Acceptance criteria from IMPLEMENTATION_PLAN.md:
 *   AC1  Responsive layout: header wraps on narrow viewports; map QR hidden at <480px;
 *        zoom controls shrink; detail panel near-full-width on mobile.
 *   AC2  Accessibility: all buttons have aria-label; detail panel traps focus and
 *        restores it on close; theme toggle has aria-live announcement; table column
 *        headers expose aria-sort; table rows are keyboard-navigable (Enter opens detail).
 *   AC3  Performance: loading overlay shown while data loads; Table button disabled
 *        until index is ready; overlay hidden once data is loaded; preconnect links present.
 *   AC4  Favicon SVG link present in document head.
 *   AC5  README.md exists and contains required sections.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BODY  = readFileSync(join(__dirname, 'maplibre-mock.js'), 'utf8');
const EMPTY_CSS  = '';

const MOCK_INDEX = {
  locations: [
    { id: 'mauna-loa',  name: 'Mauna Loa',  lat: 19.4721, lng: -155.5922, category: 'observatory', country: 'USA (Hawaii)', elevation_m: 3397, established: 1958, network: 'GHCNm' },
    { id: 'reykjavik',  name: 'Reykjavík',  lat: 64.1466, lng: -21.9426,  category: 'station',     country: 'Iceland',      elevation_m: 52,   established: 1949, network: 'GHCNm' },
    { id: 'south-pole', name: 'South Pole', lat: -90.0,   lng: 0.0,       category: 'observatory', country: 'Antarctica',   elevation_m: 2835, established: 1957, network: 'GHCNm' },
  ],
};

const MOCK_DETAIL_MAUNA_LOA = {
  name: 'Mauna Loa Observatory', country: 'USA (Hawaii)', elevation: '3397m',
  established: '1958', type: 'High-Elevation Climate Station',
  description: 'High-elevation climate station included in the GHCNm archive.',
  variables: ['CO₂', 'CH₄'], network: 'GHCNm',
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

async function loadPage(page, { hash = '', detailRoutes = {}, delay = 0 } = {}) {
  await page.route('**maplibre-gl.js**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK_BODY })
  );
  await page.route('**maplibre-gl.css**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: EMPTY_CSS })
  );
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**fonts.gstatic.com**',    route => route.fulfill({ status: 200, body: '' }));
  await page.route('**qrcode**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: QR_MOCK_BODY })
  );

  if (delay > 0) {
    // Slow index fetch so we can observe the loading state.
    await page.route('**/data/index.json', async route => {
      await new Promise(r => setTimeout(r, delay));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INDEX) });
    });
  } else {
    await page.route('**/data/index.json', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INDEX) })
    );
  }

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

async function waitForMarkers(page, timeout = 3000) {
  await page.waitForFunction(
    () => (window.__mapLayers ?? []).some(l => l.id === 'location-markers'),
    { timeout }
  );
}

async function selectStation(page, id) {
  await page.evaluate((stationId) => {
    document.dispatchEvent(new CustomEvent('location:select', { detail: { id: stationId } }));
  }, id);
}

async function waitForOverlay(page, timeout = 2000) {
  await page.waitForFunction(
    () => { const el = document.getElementById('detail-overlay'); return el && !el.hidden; },
    { timeout }
  );
}

// ── AC1: Responsive layout ────────────────────────────────────────────────────

test('AC1 – header wraps on narrow viewport (≤ 600px)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loadPage(page);
  await waitForMarkers(page);

  // At narrow width the header should expand vertically (height > normal 52px).
  const headerHeight = await page.evaluate(() =>
    document.querySelector('.app-header').getBoundingClientRect().height
  );
  // Wrapped header is taller than the fixed 3.25rem (~52px) height.
  expect(headerHeight).toBeGreaterThan(52);
});

test('AC1 – map QR container hidden at ≤ 480px viewport width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loadPage(page);
  await waitForMarkers(page);

  const qrVisible = await page.evaluate(() => {
    const el = document.getElementById('map-qr-container');
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  expect(qrVisible).toBe(false);
});

test('AC1 – map QR container visible at desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadPage(page);
  await waitForMarkers(page);

  const el = page.locator('#map-qr-container');
  await expect(el).toBeVisible();
});

test('AC1 – detail panel is near-full-width on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);
  await page.waitForSelector('.detail-panel .detail-name');

  const panelWidth = await page.evaluate(() =>
    document.querySelector('.detail-panel').getBoundingClientRect().width
  );
  // max-width: 92vw → at 375px wide, panel ≤ 345px; but should be >300px
  expect(panelWidth).toBeGreaterThan(300);
  expect(panelWidth).toBeLessThanOrEqual(375);
});

// ── AC2: Accessibility ────────────────────────────────────────────────────────

test('AC2 – all interactive buttons have aria-label', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const unlabelled = await page.evaluate(() => {
    return [...document.querySelectorAll('button')].filter(btn => {
      // aria-label or aria-labelledby or visible text content must be present.
      const label    = btn.getAttribute('aria-label');
      const labelBy  = btn.getAttribute('aria-labelledby');
      const text     = btn.textContent?.trim();
      return !label && !labelBy && !text;
    }).map(b => b.outerHTML.slice(0, 80));
  });
  expect(unlabelled).toHaveLength(0);
});

test('AC2 – detail overlay has role=dialog and aria-modal=true', async ({ page }) => {
  await loadPage(page);
  const overlay = page.locator('#detail-overlay');
  await expect(overlay).toHaveAttribute('role', 'dialog');
  await expect(overlay).toHaveAttribute('aria-modal', 'true');
});

test('AC2 – detail panel traps focus: Tab stays within dialog', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);
  // Wait for content to render and close button to be focused.
  await page.waitForSelector('.detail-panel .detail-close');
  await page.waitForTimeout(100);

  // Press Tab multiple times; focus should stay inside #detail-panel.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
  }

  const focusedInPanel = await page.evaluate(() => {
    const panel = document.getElementById('detail-panel');
    return panel.contains(document.activeElement);
  });
  expect(focusedInPanel).toBe(true);
});

test('AC2 – closing detail panel restores focus to trigger element', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  // Focus the theme toggle before opening the panel (simulates a known trigger).
  await page.focus('#theme-toggle');

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);
  await page.waitForSelector('.detail-panel .detail-close');
  await page.waitForTimeout(100);

  // Close via Escape.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const el = document.getElementById('detail-overlay');
    return el && el.hidden;
  }, { timeout: 1000 });

  // The element that was focused when the panel opened should regain focus.
  const focusedId = await page.evaluate(() => document.activeElement?.id);
  expect(focusedId).toBe('theme-toggle');
});

test('AC2 – theme toggle has aria-live announcement region', async ({ page }) => {
  await loadPage(page);
  const region = page.locator('#theme-announcement');
  await expect(region).toHaveAttribute('aria-live', 'polite');
});

test('AC2 – theme toggle populates aria-live region on change', async ({ page }) => {
  await loadPage(page);
  await page.click('#theme-toggle');
  await page.waitForTimeout(50);
  const text = await page.locator('#theme-announcement').textContent();
  expect(text?.length).toBeGreaterThan(0);
});

test('AC2 – sorted table column has aria-sort="ascending"', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Switch to table view.
  await page.click('[data-view="table"]');
  await page.waitForSelector('#table-container:not([hidden])');

  // The default sort is "name asc" — check the Name header.
  const ariaSort = await page.evaluate(() =>
    document.querySelector('th[data-col="name"]')?.getAttribute('aria-sort')
  );
  expect(ariaSort).toBe('ascending');
});

test('AC2 – clicking sorted column toggles aria-sort to descending', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.click('[data-view="table"]');
  await page.waitForSelector('#table-container:not([hidden])');

  // Click Name header to toggle direction (currently ascending → descending).
  await page.click('th[data-col="name"]');
  await page.waitForTimeout(50);

  const ariaSort = await page.evaluate(() =>
    document.querySelector('th[data-col="name"]')?.getAttribute('aria-sort')
  );
  expect(ariaSort).toBe('descending');
});

test('AC2 – unsorted columns have aria-sort="none"', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.click('[data-view="table"]');
  await page.waitForSelector('#table-container:not([hidden])');

  // Lng is not the default sort column.
  const ariaSort = await page.evaluate(() =>
    document.querySelector('th[data-col="lng"]')?.getAttribute('aria-sort')
  );
  expect(ariaSort).toBe('none');
});

test('AC2 – table rows have tabindex=0 (keyboard-navigable)', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.click('[data-view="table"]');
  await page.waitForSelector('.station-row');

  const tabindex = await page.evaluate(() =>
    document.querySelector('.station-row')?.getAttribute('tabindex')
  );
  expect(tabindex).toBe('0');
});

test('AC2 – Enter key on table row opens detail panel', async ({ page }) => {
  await loadPage(page, { detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA } });
  await waitForMarkers(page);

  await page.click('[data-view="table"]');
  await page.waitForSelector('.station-row');

  // Focus the first row with the Mauna Loa entry and press Enter.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr[data-id]')]
      .find(r => r.dataset.id === 'mauna-loa');
    row?.focus();
  });
  await page.keyboard.press('Enter');

  await waitForOverlay(page);
  const visible = await page.evaluate(() => !document.getElementById('detail-overlay').hidden);
  expect(visible).toBe(true);
});

// ── AC3: Performance / loading state ─────────────────────────────────────────

test('AC3 – loading overlay exists in the DOM', async ({ page }) => {
  await loadPage(page);
  await expect(page.locator('#loading-overlay')).toBeAttached();
});

test('AC3 – Table button is disabled before index data loads', async ({ page }) => {
  // Delay the index fetch so we can observe the disabled state.
  await loadPage(page, { delay: 200 });

  // Immediately after navigation, before the delayed index arrives, Table btn should be disabled.
  const disabled = await page.evaluate(() =>
    document.querySelector('[data-view="table"]')?.disabled
  );
  expect(disabled).toBe(true);
});

test('AC3 – loading overlay is hidden after data loads', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // After markers load the overlay should have the .ready class (opacity:0 / hidden).
  const hasReady = await page.evaluate(() =>
    document.getElementById('loading-overlay')?.classList.contains('ready')
  );
  expect(hasReady).toBe(true);
});

test('AC3 – Table button is enabled after index data loads', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const disabled = await page.evaluate(() =>
    document.querySelector('[data-view="table"]')?.disabled
  );
  expect(disabled).toBe(false);
});

test('AC3 – preconnect link for unpkg.com is in document head', async ({ page }) => {
  await loadPage(page);
  const hasPreconnect = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="preconnect"]')]
      .some(l => l.href.includes('unpkg.com'))
  );
  expect(hasPreconnect).toBe(true);
});

test('AC3 – preconnect link for cdnjs.cloudflare.com is in document head', async ({ page }) => {
  await loadPage(page);
  const hasPreconnect = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="preconnect"]')]
      .some(l => l.href.includes('cdnjs.cloudflare.com'))
  );
  expect(hasPreconnect).toBe(true);
});

// ── AC4: Favicon ──────────────────────────────────────────────────────────────

test('AC4 – SVG favicon link is present in head', async ({ page }) => {
  await loadPage(page);
  const favicon = await page.evaluate(() => {
    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    return link?.href ?? null;
  });
  expect(favicon).not.toBeNull();
  expect(favicon).toMatch(/favicon\.svg/);
});

// ── AC5: README ───────────────────────────────────────────────────────────────

test('AC5 – README.md exists in the meridian directory', async () => {
  const readmePath = join(__dirname, '..', 'README.md');
  expect(existsSync(readmePath)).toBe(true);
});

test('AC5 – README contains "Running locally" section', async () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  expect(readme).toMatch(/running locally/i);
});

test('AC5 – README contains "No API token" section', async () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  expect(readme).toMatch(/no api token/i);
});

test('AC5 – README documents the URL hash format', async () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  expect(readme).toMatch(/#map=/);
  expect(readme).toMatch(/#station=/);
  expect(readme).toMatch(/#table=/);
});

test('AC5 – README mentions no API token required', async () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  expect(readme).toMatch(/no api token/i);
});

test('AC5 – README includes deployment instructions', async () => {
  const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
  expect(readme).toMatch(/deployment/i);
});

// ── AC6: No console errors ────────────────────────────────────────────────────

test('AC6 – no console errors on normal page load', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await loadPage(page);
  await waitForMarkers(page);
  await page.waitForTimeout(200);

  expect(errors).toHaveLength(0);
});

test('AC6 – no console errors when switching to table view', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  await loadPage(page);
  await waitForMarkers(page);

  await page.click('[data-view="table"]');
  await page.waitForSelector('#table-container:not([hidden])');
  await page.waitForTimeout(100);

  expect(errors).toHaveLength(0);
});
