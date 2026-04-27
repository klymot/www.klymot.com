/**
 * Phase 9 acceptance tests — LOESS slider display and dual-mode (span / years)
 *
 * Acceptance criteria:
 *   AC1  Aggregate graph: span button shows the fraction; years button shows
 *        the SMA-equivalent "N yr" after data loads. Span is selected by
 *        default (0.01–0.99, step 0.01).
 *   AC2  Detail panel: same dual-button behaviour after LOESS is enabled.
 *   AC3  Clicking the years button switches the slider to integer year mode
 *        (2–60 yr) in both aggregate and detail views.
 *   AC4  Year-mode slider updates the span and both buttons correctly.
 *   AC5  URL round-trip: span mode uses integer (no suffix); year mode appends
 *        'y'; restoring a 'y' URL re-enters year mode.
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
    start:         `${startYear}-01`,
    station_count: 5,
    counts:        Array(numMonths).fill(5),
    averages:      Array(numMonths).fill(15.0),
    std_devs:      Array(numMonths).fill(0.5),
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
  await page.route('**/api/v1/reference-coverage', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"years":{},"decades":{}}' })
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

// ── SMA-equivalence helper (must match getLoessEffectiveYears in temp-chart.js) ─

/**
 * Compute the expected SMA-equivalent window width in years.
 * k = max(3, round(span · n)) tricube-weighted neighbours;
 * SMA equiv = max(1, round(k / 1.40))  (Loader 1999 variance-matching factor).
 */
function smaEquiv(span, nYears) {
  const k = Math.max(3, Math.round(span * nYears));
  return Math.max(1, Math.round(k / 1.40));
}

// ── AC1: Aggregate graph ──────────────────────────────────────────────────────

test('AC1 – aggregate LOESS slider shows span and SMA-equivalent years after data loads', async ({ page }) => {
  // 50 complete years: n=50, span=0.30 → k=15 → SMA=round(15/1.40)=11
  const AGG_YEARS  = 50;
  const EXPECTED   = smaEquiv(0.30, AGG_YEARS); // 11

  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  // Navigate directly to the graph view with LOESS enabled at the default span.
  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  // Wait for the years button to reflect the loaded data.
  await page.waitForFunction(
    (expected) => document.querySelector('.loess-years-btn')?.textContent?.includes(`${expected} yr`),
    EXPECTED,
    { timeout: 5000 }
  );

  const spanText  = await page.locator('.loess-span-btn').first().textContent();
  const yearsText = await page.locator('.loess-years-btn').first().textContent();
  expect(spanText).toBe('0.30');
  expect(yearsText).toBe(`${EXPECTED} yr`);

  // Span button should be active (selected) by default.
  const spanActive = await page.locator('.loess-span-btn').first().getAttribute('aria-pressed');
  expect(spanActive).toBe('true');
  const yearsActive = await page.locator('.loess-years-btn').first().getAttribute('aria-pressed');
  expect(yearsActive).toBe('false');

  // Slider should be in span mode: range 1–99, step 1.
  const slider = page.locator('.loess-range').first();
  expect(await slider.getAttribute('min')).toBe('1');
  expect(await slider.getAttribute('max')).toBe('99');
});

test('AC1 – aggregate LOESS span slider updates both buttons when span changes', async ({ page }) => {
  const AGG_YEARS = 50;

  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  // Wait for initial data to load.
  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.textContent?.includes(' yr'),
    { timeout: 5000 }
  );

  // Move slider to span=0.50; SMA equiv = round(max(3,round(0.50×50))/1.40) = round(25/1.40) = 18.
  const EXPECTED_50 = smaEquiv(0.50, AGG_YEARS); // 18
  await page.evaluate(() => {
    const slider = document.querySelector('.loess-range');
    if (slider) {
      slider.value = '50';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.waitForFunction(
    (expected) => document.querySelector('.loess-years-btn')?.textContent?.includes(`${expected} yr`),
    EXPECTED_50,
    { timeout: 2000 }
  );

  const spanText  = await page.locator('.loess-span-btn').first().textContent();
  const yearsText = await page.locator('.loess-years-btn').first().textContent();
  expect(spanText).toBe('0.50');
  expect(yearsText).toBe(`${EXPECTED_50} yr`);
});

// ── AC2: Detail panel ─────────────────────────────────────────────────────────

test('AC2 – detail-panel LOESS shows span and SMA-equivalent years after chart data loads', async ({ page }) => {
  // 30 complete years: n=30, span=0.30 → k=9 → SMA=round(9/1.40)=6
  const DETAIL_YEARS = 30;
  const CSV_DATA     = makeMockCsv(1990, DETAIL_YEARS);
  const EXPECTED     = smaEquiv(0.30, DETAIL_YEARS); // 6

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

  // The years button should update once data has loaded and LOESS is enabled.
  await page.waitForFunction(
    (expected) => {
      const els = document.querySelectorAll('.detail-panel .loess-years-btn');
      return [...els].some(el => el.textContent?.includes(`${expected} yr`));
    },
    EXPECTED,
    { timeout: 5000 }
  );

  const spanText  = await page.locator('.detail-panel .loess-span-btn').first().textContent();
  const yearsText = await page.locator('.detail-panel .loess-years-btn').first().textContent();
  expect(spanText).toBe('0.30');
  expect(yearsText).toBe(`${EXPECTED} yr`);

  // Span button is active by default.
  const spanActive = await page.locator('.detail-panel .loess-span-btn').first().getAttribute('aria-pressed');
  expect(spanActive).toBe('true');
});

test('AC2 – detail-panel LOESS span slider updates both buttons when span changes', async ({ page }) => {
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
    () => [...document.querySelectorAll('.detail-panel .loess-years-btn')]
      .some(el => el.textContent?.includes(' yr')),
    { timeout: 5000 }
  );

  // Move slider to span=0.50; SMA equiv = round(max(3,round(0.50×30))/1.40) = round(15/1.40) = 11.
  const EXPECTED_50 = smaEquiv(0.50, DETAIL_YEARS); // 11
  await page.evaluate(() => {
    const slider = document.querySelector('.detail-panel .loess-range');
    if (slider) {
      slider.value = '50';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('.detail-panel .loess-years-btn')]
      .some(el => el.textContent?.includes(`${expected} yr`)),
    EXPECTED_50,
    { timeout: 2000 }
  );

  const spanText  = await page.locator('.detail-panel .loess-span-btn').first().textContent();
  const yearsText = await page.locator('.detail-panel .loess-years-btn').first().textContent();
  expect(spanText).toBe('0.50');
  expect(yearsText).toBe(`${EXPECTED_50} yr`);
});

// ── AC3: clicking years button switches slider to year mode ───────────────────

test('AC3 – clicking years button switches aggregate slider to year mode (2–60)', async ({ page }) => {
  const AGG_YEARS = 50;
  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  // Wait for data so getLoessEffectiveYears returns a value.
  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.textContent?.includes(' yr'),
    { timeout: 5000 }
  );

  // Click the years button.
  await page.locator('.loess-years-btn').first().click();

  // Slider should now be in year mode: range 2–60, step 1.
  const slider = page.locator('.loess-range').first();
  expect(await slider.getAttribute('min')).toBe('2');
  expect(await slider.getAttribute('max')).toBe('60');
  expect(await slider.getAttribute('step')).toBe('1');

  // Years button should be active, span button inactive.
  expect(await page.locator('.loess-years-btn').first().getAttribute('aria-pressed')).toBe('true');
  expect(await page.locator('.loess-span-btn').first().getAttribute('aria-pressed')).toBe('false');
});

test('AC3 – clicking years button switches detail-panel slider to year mode (2–60)', async ({ page }) => {
  const DETAIL_YEARS = 30;
  const CSV_DATA = makeMockCsv(1990, DETAIL_YEARS);

  await loadPage(page, {
    detailRoutes: { 'mauna-loa': MOCK_DETAIL_MAUNA_LOA },
    csvRoutes:    { 'mauna-loa': { qcu: CSV_DATA, qcf: CSV_DATA, tob: '' } },
  });
  await waitForMarkers(page);
  await selectStation(page, 'mauna-loa');
  await waitForOverlay(page);

  await page.waitForSelector('.detail-panel [data-action="loess-toggle"]', { timeout: 3000 });
  await page.locator('.detail-panel [data-action="loess-toggle"]').first().click();

  await page.waitForFunction(
    () => [...document.querySelectorAll('.detail-panel .loess-years-btn')]
      .some(el => el.textContent?.includes(' yr')),
    { timeout: 5000 }
  );

  // Click the years button in the detail panel.
  await page.locator('.detail-panel .loess-years-btn').first().click();

  const slider = page.locator('.detail-panel .loess-range').first();
  expect(await slider.getAttribute('min')).toBe('2');
  expect(await slider.getAttribute('max')).toBe('60');

  expect(await page.locator('.detail-panel .loess-years-btn').first().getAttribute('aria-pressed')).toBe('true');
  expect(await page.locator('.detail-panel .loess-span-btn').first().getAttribute('aria-pressed')).toBe('false');
});

// ── AC4: year-mode slider updates span correctly ──────────────────────────────

test('AC4 – year-mode slider updates span button in aggregate view', async ({ page }) => {
  const AGG_YEARS = 50;
  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.textContent?.includes(' yr'),
    { timeout: 5000 }
  );

  // Switch to year mode.
  await page.locator('.loess-years-btn').first().click();

  // Move year slider to 15 yr.
  await page.evaluate(() => {
    const slider = document.querySelector('.loess-range');
    if (slider) {
      slider.value = '15';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Span button should show the equivalent span fraction:
  // k = max(3, round(15 * 1.40)) = 21; span = 21 / 50 = 0.42
  const expectedSpan = Math.max(0.01, Math.min(0.99, Math.max(3, Math.round(15 * 1.40)) / AGG_YEARS));
  await page.waitForFunction(
    (sp) => document.querySelector('.loess-span-btn')?.textContent === sp.toFixed(2),
    expectedSpan,
    { timeout: 2000 }
  );

  const spanText  = await page.locator('.loess-span-btn').first().textContent();
  const yearsText = await page.locator('.loess-years-btn').first().textContent();
  expect(spanText).toBe(expectedSpan.toFixed(2));
  expect(yearsText).toBe('15 yr');
});

// ── AC5: URL round-trip ───────────────────────────────────────────────────────

test('AC5 – span mode URL uses integer, year mode appends y suffix', async ({ page }) => {
  const AGG_YEARS = 50;
  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess' });

  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.textContent?.includes(' yr'),
    { timeout: 5000 }
  );

  // Move span slider to 0.50 — URL should contain loessspan=50 (no 'y').
  await page.evaluate(() => {
    const s = document.querySelector('.loess-range');
    if (s) { s.value = '50'; s.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForFunction(() => location.hash.includes('loessspan=50'), { timeout: 2000 });
  expect(await page.evaluate(() => location.hash)).toContain('loessspan=50');
  expect(await page.evaluate(() => location.hash)).not.toContain('loessspan=50y');

  // Switch to year mode and set slider to 15 yr — URL should contain loessspan=15y.
  await page.locator('.loess-years-btn').first().click();
  await page.evaluate(() => {
    const s = document.querySelector('.loess-range');
    if (s) { s.value = '15'; s.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForFunction(() => location.hash.includes('loessspan=15y'), { timeout: 2000 });
  expect(await page.evaluate(() => location.hash)).toContain('loessspan=15y');
});

test('AC5 – restoring URL with loessspan=Ny enters year mode', async ({ page }) => {
  const AGG_YEARS = 50;
  await page.route('**/api/v1/aggregate', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeMockAggregateResponse(1970, AGG_YEARS)),
    })
  );

  // Load directly into year mode with 15yr.
  await loadPage(page, { hash: '#graph=qcu/monthly/-/loess,loessspan=15y' });

  // Slider should be in year mode (range 2–60).
  await page.waitForSelector('.loess-range', { timeout: 5000 });
  const slider = page.locator('.loess-range').first();
  expect(await slider.getAttribute('min')).toBe('2');
  expect(await slider.getAttribute('max')).toBe('60');
  expect(await slider.getAttribute('step')).toBe('1');
  expect(await slider.inputValue()).toBe('15');

  // Years button should be active.
  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.getAttribute('aria-pressed') === 'true',
    { timeout: 3000 }
  );

  // Wait for data to load and span to be computed from 15yr.
  await page.waitForFunction(
    () => document.querySelector('.loess-years-btn')?.textContent?.includes(' yr'),
    { timeout: 5000 }
  );

  // Span button shows span computed from 15yr with n=50: k=round(15*1.40)=21, span=21/50=0.42
  const expectedSpan = Math.max(0.01, Math.min(0.99, Math.max(3, Math.round(15 * 1.40)) / AGG_YEARS));
  await page.waitForFunction(
    (sp) => document.querySelector('.loess-span-btn')?.textContent === sp.toFixed(2),
    expectedSpan,
    { timeout: 3000 }
  );

  expect(await page.locator('.loess-span-btn').first().textContent()).toBe(expectedSpan.toFixed(2));
  expect(await page.locator('.loess-years-btn').first().textContent()).toBe('15 yr');
});
