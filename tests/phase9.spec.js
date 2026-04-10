/**
 * Phase 9 acceptance tests — LOESS slider effective-years display
 *
 * Acceptance criteria:
 *   AC1  Aggregate graph LOESS slider value shows "0.30 (N yr)" after data
 *        loads, where N = max(3, round(span × n_yearly_observations)).
 *   AC2  Detail-panel LOESS slider value shows "0.30 (N yr)" after chart
 *        data loads and LOESS is enabled.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BODY  = readFileSync(join(__dirname, 'maplibre-mock.js'), 'utf8');
const EMPTY_CSS  = '';

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_INDEX = {
  locations: [
    {
      id: 'mauna-loa', name: 'Mauna Loa', lat: 19.4721, lng: -155.5922,
      category: 'observatory', country: 'USA (Hawaii)', elevation_m: 3397,
      established: 1958, network: 'GHCNm',
    },
  ],
};

const MOCK_DETAIL_MAUNA_LOA = {
  name:        'Mauna Loa Observatory',
  country:     'USA (Hawaii)',
  elevation:   '3397m',
  established: '1958',
  type:        'High-Elevation Climate Station',
  description: 'High-elevation climate station.',
  variables:   [],
  network:     'GHCNm',
};

const QR_MOCK_BODY = `
window.qrcode = function(typeNumber, errorCorrectionLevel) {
  var _data = '';
  return {
    addData: function(d) { _data = d; },
    make:    function() {},
    createSvgTag: function() {
      return '<svg xmlns="http://www.w3.org/2000/svg" data-qr-url="' + _data + '"><rect/></svg>';
    }
  };
};
`;

/**
 * Build a CSV string with `numYears` complete years (all 12 months present).
 * Values are in 1/100 °C (e.g. 1500 = 15.00 °C).
 * _yearlyPoints() skips years that have any null month, so all months must be
 * filled for the year to count toward getLoessEffectiveYears().
 */
function makeMockCsv(startYear, numYears, value = 1500) {
  return Array.from({ length: numYears }, (_, i) =>
    `${startYear + i},${Array(12).fill(value).join(',')}`
  ).join('\n');
}

/**
 * Build a synthetic aggregate-API response object.
 * `numYears` complete years starting from `startYear`.
 * The response mimics what /api/v1/aggregate returns.
 */
function makeMockAggregateResponse(startYear, numYears) {
  const numMonths = numYears * 12;
  return {
    start:    `${startYear}-01-01`,
    counts:   Array(numMonths).fill(5),      // 5 stations per month slot
    averages: Array(numMonths).fill(15.0),   // 15 °C
    std_devs: Array(numMonths).fill(0.5),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadPage(page, {
  hash        = '',
  csvRoutes   = {},   // { '<stationId>': { qcu, qcf, tob } }
  detailRoutes = {},
} = {}) {
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
  await page.route('**/api/v1/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  );
  await page.route('**/data/index.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_INDEX) })
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

  for (const [id, csvs] of Object.entries(csvRoutes)) {
    for (const series of ['qcu', 'qcf']) {
      const body = csvs[series] ?? '';
      await page.route(`**/data/${series}/${id}.csv`, route =>
        route.fulfill({ status: 200, contentType: 'text/plain', body })
      );
    }
    const tobBody = csvs.tob ?? '';
    await page.route(`**/data/tob/${id}.csv`, route =>
      route.fulfill({ status: 200, contentType: 'text/plain', body: tobBody })
    );
  }

  // Strip SRI integrity attributes so CDN mocks are not blocked.
  await page.route(u => ['/', '/index.html'].includes(new URL(u).pathname), async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/ integrity="[^"]*"/g, '');
    await route.fulfill({ response, body });
  });

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

// ── AC1: Aggregate graph ──────────────────────────────────────────────────────

test('AC1 – aggregate LOESS slider shows effective years after data loads', async ({ page }) => {
  // 50 complete years of data: n=50, span=0.30 → k=max(3,round(0.30×50))=15
  const AGG_YEARS = 50;
  const AGG_RESPONSE = makeMockAggregateResponse(1970, AGG_YEARS);
  const EXPECTED_K = Math.max(3, Math.round(0.30 * AGG_YEARS)); // 15

  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AGG_RESPONSE),
    })
  );

  // Navigate directly to the graph view with LOESS enabled at the default span.
  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  // Wait for the LOESS slider value to reflect the loaded data.
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector('.loess-slider-value');
      return el?.textContent?.includes(`(${expected} yr)`);
    },
    EXPECTED_K,
    { timeout: 5000 }
  );

  const text = await page.locator('.loess-slider-value').first().textContent();
  expect(text).toMatch(/0\.30 \(\d+ yr\)/);
  expect(text).toContain(`(${EXPECTED_K} yr)`);
});

test('AC1 – aggregate LOESS slider updates effective years when span changes', async ({ page }) => {
  const AGG_YEARS = 50;
  const AGG_RESPONSE = makeMockAggregateResponse(1970, AGG_YEARS);

  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AGG_RESPONSE),
    })
  );

  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  // Wait for initial data to load.
  await page.waitForFunction(
    () => document.querySelector('.loess-slider-value')?.textContent?.includes(' yr)'),
    { timeout: 5000 }
  );

  // Move slider to span=0.50; expected k = max(3, round(0.50×50)) = 25.
  const EXPECTED_K_50 = Math.max(3, Math.round(0.50 * AGG_YEARS)); // 25
  await page.evaluate(() => {
    const slider = document.querySelector('.loess-range');
    if (slider) {
      slider.value = '50';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.waitForFunction(
    (expected) => document.querySelector('.loess-slider-value')?.textContent?.includes(`(${expected} yr)`),
    EXPECTED_K_50,
    { timeout: 2000 }
  );

  const text = await page.locator('.loess-slider-value').first().textContent();
  expect(text).toContain(`0.50 (${EXPECTED_K_50} yr)`);
});

// ── AC2: Detail panel ─────────────────────────────────────────────────────────

test('AC2 – detail-panel LOESS slider shows effective years after chart data loads', async ({ page }) => {
  // 30 complete years of data: n=30, span=0.30 → k=max(3,round(0.30×30))=9
  const DETAIL_YEARS = 30;
  const CSV_DATA     = makeMockCsv(1990, DETAIL_YEARS);
  const EXPECTED_K   = Math.max(3, Math.round(0.30 * DETAIL_YEARS)); // 9

  await loadPage(page, {
    detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA },
    csvRoutes:    { 'mauna-loa': { qcu: CSV_DATA, qcf: CSV_DATA, tob: '' } },
  });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  // Enable LOESS via the first available toggle button in the detail panel.
  await page.waitForSelector('.detail-panel [data-action="loess-toggle"]', { timeout: 3000 });
  await page.locator('.detail-panel [data-action="loess-toggle"]').first().click();

  // The display should update once data has loaded and LOESS is enabled.
  await page.waitForFunction(
    (expected) => {
      const els = document.querySelectorAll('.detail-panel .loess-slider-value');
      return [...els].some(el => el.textContent?.includes(`(${expected} yr)`));
    },
    EXPECTED_K,
    { timeout: 5000 }
  );

  const text = await page.locator('.detail-panel .loess-slider-value').first().textContent();
  expect(text).toMatch(/0\.30 \(\d+ yr\)/);
  expect(text).toContain(`(${EXPECTED_K} yr)`);
});

test('AC2 – detail-panel LOESS slider updates effective years when span changes', async ({ page }) => {
  const DETAIL_YEARS = 30;
  const CSV_DATA     = makeMockCsv(1990, DETAIL_YEARS);

  await loadPage(page, {
    detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA },
    csvRoutes:    { 'mauna-loa': { qcu: CSV_DATA, qcf: CSV_DATA, tob: '' } },
  });
  await waitForMarkers(page);

  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  // Enable LOESS.
  await page.waitForSelector('.detail-panel [data-action="loess-toggle"]', { timeout: 3000 });
  await page.locator('.detail-panel [data-action="loess-toggle"]').first().click();

  // Wait for initial effective-years display.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.detail-panel .loess-slider-value')]
      .some(el => el.textContent?.includes(' yr)')),
    { timeout: 5000 }
  );

  // Move slider to span=0.50; k = max(3, round(0.50×30)) = 15.
  const EXPECTED_K_50 = Math.max(3, Math.round(0.50 * DETAIL_YEARS)); // 15
  await page.evaluate(() => {
    const slider = document.querySelector('.detail-panel .loess-range');
    if (slider) {
      slider.value = '50';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('.detail-panel .loess-slider-value')]
      .some(el => el.textContent?.includes(`(${expected} yr)`)),
    EXPECTED_K_50,
    { timeout: 2000 }
  );

  const text = await page.locator('.detail-panel .loess-slider-value').first().textContent();
  expect(text).toContain(`0.50 (${EXPECTED_K_50} yr)`);
});
