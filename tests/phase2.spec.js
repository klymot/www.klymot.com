/**
 * Phase 2 acceptance tests — Location Markers & Labels
 *
 * Acceptance criteria from IMPLEMENTATION_PLAN.md:
 *   AC1  All locations from index.json appear on the map (clustered at low zoom,
 *        individual at high zoom).
 *   AC2  Clusters show a count and expand on click.
 *   AC3  Observatory and station markers are visually distinct colours when unclustered.
 *   AC4  Labels appear only when zoomed in sufficiently (minzoom 8+).
 *   AC5  Markers and clusters change colour correctly when theme toggles.
 *   AC6  Clicking an unclustered marker triggers the detail panel (dispatches
 *        'location:select' custom event — panel wired in Phase 4).
 *   AC7  Footer station count is updated from the loaded index.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BODY  = readFileSync(join(__dirname, 'maplibre-mock.js'), 'utf8');
const EMPTY_CSS  = '';

// Minimal index used by all tests (keeps test data self-contained).
const MOCK_INDEX = {
  locations: [
    { id: 'mauna-loa',  name: 'Mauna Loa',  lat: 19.4721, lng: -155.5922, category: 'observatory', country: 'USA (Hawaii)',  elevation_m: 3397, established: 1958, network: 'GHCNm' },
    { id: 'reykjavik',  name: 'Reykjavík',  lat: 64.1466, lng: -21.9426,  category: 'station',     country: 'Iceland',       elevation_m: 52,   established: 1949, network: 'GHCNm' },
    { id: 'south-pole', name: 'South Pole', lat: -90.0,   lng: 0.0,       category: 'observatory', country: 'Antarctica',    elevation_m: 2835, established: 1957, network: 'GHCNm' },
    { id: 'tokyo',      name: 'Tokyo',      lat: 35.6762, lng: 139.6503,  category: 'station',     country: 'Japan',         elevation_m: 25,   established: 1875, network: 'WMO / JMA' },
    { id: 'svalbard',   name: 'Svalbard',   lat: 78.2232, lng: 15.6267,   category: 'station',     country: 'Norway',        elevation_m: 28,   established: 1969, network: 'GHCNm' },
  ],
};

// ── Test helpers ─────────────────────────────────────────────────────────────

async function loadPage(page) {
  await page.route('**maplibre-gl.js**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK_BODY })
  );
  await page.route('**maplibre-gl.css**', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: EMPTY_CSS })
  );
  await page.route('**fonts.googleapis.com**', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**fonts.gstatic.com**',    route => route.fulfill({ status: 200, body: '' }));
  await page.route('**/data/index.json', route =>
    route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        JSON.stringify(MOCK_INDEX),
    })
  );

  await page.goto('/');
}

/** Wait until the 'location-markers' layer has been added to the mock map. */
async function waitForMarkers(page, timeout = 3000) {
  await page.waitForFunction(
    () => (window.__mapLayers ?? []).some(l => l.id === 'location-markers'),
    { timeout }
  );
}

// ── AC1: Locations loaded and GeoJSON source added ───────────────────────────

test('AC1 – locations source is added with cluster enabled', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const source = await page.evaluate(() => window.__mapSources?.locations);
  expect(source).not.toBeNull();
  expect(source.cluster).toBe(true);
  expect(source.clusterRadius).toBe(50);
  expect(source.clusterMaxZoom).toBe(10);
});

test('AC1 – GeoJSON source contains all loaded locations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const featureCount = await page.evaluate(() =>
    window.__mapSources?.locations?.data?.features?.length ?? 0
  );
  expect(featureCount).toBe(MOCK_INDEX.locations.length);
});

test('AC1 – each feature has the correct id, name, and category properties', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const features = await page.evaluate(() =>
    window.__mapSources?.locations?.data?.features ?? []
  );

  const maunaLoa = features.find(f => f.properties.id === 'mauna-loa');
  expect(maunaLoa).toBeDefined();
  expect(maunaLoa.properties.name).toBe('Mauna Loa');
  expect(maunaLoa.properties.category).toBe('observatory');
  expect(maunaLoa.geometry.coordinates).toEqual([-155.5922, 19.4721]);
});

// ── AC2: Clusters layer and click-to-expand ───────────────────────────────────

test('AC2 – clusters layer is added with correct filter', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'clusters')
  );
  expect(layer).toBeDefined();
  // Filter must target clustered points
  expect(JSON.stringify(layer.filter)).toContain('point_count');
});

test('AC2 – cluster-count symbol layer is added', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'cluster-count')
  );
  expect(layer).toBeDefined();
  expect(layer.type).toBe('symbol');
});

test('AC2 – clicking a cluster calls map.easeTo with higher zoom', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Record easeTo calls on the mock map instance.
  await page.evaluate(() => {
    window.__easeToArgs = [];
    const orig = window.__mapInstance.easeTo.bind(window.__mapInstance);
    window.__mapInstance.easeTo = (opts) => {
      window.__easeToArgs.push(opts);
      return orig(opts);
    };
  });

  // Simulate clicking the 'clusters' layer with a fake cluster feature.
  await page.evaluate(() => {
    window.__mapInstance._emitLayer('click', 'clusters', [{
      geometry:   { type: 'Point', coordinates: [-155, 20] },
      properties: { cluster_id: 42, point_count: 5 },
    }]);
  });

  // getClusterExpansionZoom mock returns 8; easeTo should be called with zoom 8.
  await page.waitForFunction(() => window.__easeToArgs?.length > 0, { timeout: 1000 });

  const easeArgs = await page.evaluate(() => window.__easeToArgs);
  expect(easeArgs[0].zoom).toBe(8);
  expect(easeArgs[0].center).toEqual([-155, 20]);
});

// ── AC3: Visual distinction between observatory and station markers ───────────

test('AC3 – location-markers layer uses circle-color driven by category', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'location-markers')
  );
  expect(layer).toBeDefined();

  // circle-color must be a 'match' expression on the category property.
  const colorExpr = JSON.stringify(layer.paint?.['circle-color'] ?? '');
  expect(colorExpr).toContain('match');
  expect(colorExpr).toContain('category');
  expect(colorExpr).toContain('observatory');
});

test('AC3 – observatory and station receive different marker colours in dark theme', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const colors = await page.evaluate(() => {
    const layer = (window.__mapLayers ?? []).find(l => l.id === 'location-markers');
    // circle-color = ['match', ['get', 'category'], 'observatory', OBS_COLOR, STATION_COLOR]
    const expr = layer?.paint?.['circle-color'];
    if (!Array.isArray(expr)) return null;
    // expr[2] = 'observatory', expr[3] = observatory color, expr[4] = station (default) color
    return { observatory: expr[3], station: expr[4] };
  });

  expect(colors).not.toBeNull();
  expect(colors.observatory).not.toBe(colors.station);
  // Dark theme defaults
  expect(colors.observatory).toBe('#5ca8c4');
  expect(colors.station).toBe('#d4a855');
});

// ── AC4: Label layer has minzoom ≥ 8 ─────────────────────────────────────────

test('AC4 – location-labels layer has minzoom of 8', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'location-labels')
  );
  expect(layer).toBeDefined();
  expect(layer.minzoom).toBeGreaterThanOrEqual(8);
});

test('AC4 – location-labels layer uses name field and is filtered to unclustered points', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'location-labels')
  );
  expect(JSON.stringify(layer.layout?.['text-field'])).toContain('name');
  expect(JSON.stringify(layer.filter)).toContain('point_count');
});

test('AC4 – geographic latitude label layer is added with text labels', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const layer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'geographic-line-labels-layer')
  );
  expect(layer).toBeDefined();
  expect(layer.type).toBe('symbol');
  expect(JSON.stringify(layer.layout?.['text-field'])).toContain('label');
  expect(layer.layout?.['symbol-placement']).toBe('line');
  expect(layer.layout?.['text-max-width']).toBe(100);
  const lineLayer = await page.evaluate(() =>
    (window.__mapLayers ?? []).find(l => l.id === 'geographic-lines-layer')
  );
  expect(layer.paint?.['text-color']).toBe(lineLayer.paint?.['line-color']);
  expect(layer.paint?.['text-halo-color']).toBeUndefined();
  expect(layer.paint?.['text-halo-width']).toBeUndefined();
});

test('AC4 – geographic latitude label source includes equator and tropic labels', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const labels = await page.evaluate(() =>
    (window.__mapSources?.['geographic-lines']?.data?.features ?? [])
      .map(f => f.properties?.label)
  );
  expect(labels).toContain('EQUATOR');
  expect(labels).toContain('TROPIC OF CANCER');
  expect(labels).toContain('TROPIC OF CAPRICORN');
});

// ── AC5: Theme toggle updates marker colours ──────────────────────────────────

test('AC5 – location-markers circle-color changes to light palette after theme toggle', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Capture dark-theme observatory color.
  const darkObsColor = await page.evaluate(() => {
    const layer = (window.__mapLayers ?? []).find(l => l.id === 'location-markers');
    return layer?.paint?.['circle-color']?.[3];
  });

  // Toggle to light theme.
  await page.click('#theme-toggle');

  // Wait for layers to be re-added with light-theme colours.
  await page.waitForFunction(
    () => {
      const layer = (window.__mapLayers ?? []).find(l => l.id === 'location-markers');
      // Light observatory color is '#1e6e90'
      return layer?.paint?.['circle-color']?.[3] === '#1e6e90';
    },
    { timeout: 2000 }
  );

  const lightObsColor = await page.evaluate(() => {
    const layer = (window.__mapLayers ?? []).find(l => l.id === 'location-markers');
    return layer?.paint?.['circle-color']?.[3];
  });

  expect(lightObsColor).toBe('#1e6e90');
  expect(lightObsColor).not.toBe(darkObsColor);
});

test('AC5 – locations source is re-added after theme toggle', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.click('#theme-toggle');

  // After style reload triggered by theme change, the source must exist again.
  await page.waitForFunction(
    () => window.__mapSources?.locations?.cluster === true,
    { timeout: 2000 }
  );

  const source = await page.evaluate(() => window.__mapSources?.locations);
  expect(source.cluster).toBe(true);
  // All features should still be present.
  expect(source.data.features.length).toBe(MOCK_INDEX.locations.length);
});

// ── AC6: Unclustered marker click dispatches location:select event ────────────

test('AC6 – clicking a marker dispatches location:select with the correct id', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  // Listen for the custom event before triggering the click.
  await page.evaluate(() => {
    window.__locationSelectEvents = [];
    document.addEventListener('location:select', (e) => {
      window.__locationSelectEvents.push(e.detail);
    });
  });

  // Simulate clicking 'location-markers' layer with a mauna-loa feature.
  await page.evaluate(() => {
    window.__mapInstance._emitLayer('click', 'location-markers', [{
      geometry:   { type: 'Point', coordinates: [-155.5922, 19.4721] },
      properties: { id: 'mauna-loa', name: 'Mauna Loa', category: 'observatory' },
    }]);
  });

  await page.waitForFunction(
    () => window.__locationSelectEvents?.length > 0,
    { timeout: 1000 }
  );

  const events = await page.evaluate(() => window.__locationSelectEvents);
  expect(events[0].id).toBe('mauna-loa');
});

test('AC6 – clicking a different marker fires event with its id', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.evaluate(() => {
    window.__locationSelectEvents = [];
    document.addEventListener('location:select', (e) => {
      window.__locationSelectEvents.push(e.detail);
    });
  });

  await page.evaluate(() => {
    window.__mapInstance._emitLayer('click', 'location-markers', [{
      geometry:   { type: 'Point', coordinates: [-21.9426, 64.1466] },
      properties: { id: 'reykjavik', name: 'Reykjavík', category: 'station' },
    }]);
  });

  await page.waitForFunction(() => window.__locationSelectEvents?.length > 0, { timeout: 1000 });
  const events = await page.evaluate(() => window.__locationSelectEvents);
  expect(events[0].id).toBe('reykjavik');
});

// ── AC7: Footer station count ─────────────────────────────────────────────────

test('AC7 – footer shows the number of loaded stations', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  const text = await page.locator('#station-count').textContent();
  expect(text).toContain(String(MOCK_INDEX.locations.length));
  expect(text).toContain('stations');
});

// ── Cursor behaviour ──────────────────────────────────────────────────────────

test('cursor is set to pointer on marker mouseenter', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.evaluate(() =>
    window.__mapInstance._emitLayer('mouseenter', 'location-markers', [])
  );
  const cursor = await page.evaluate(() => window.__mapInstance.getCanvas().style.cursor);
  expect(cursor).toBe('pointer');
});

test('cursor is cleared on marker mouseleave', async ({ page }) => {
  await loadPage(page);
  await waitForMarkers(page);

  await page.evaluate(() => {
    window.__mapInstance._emitLayer('mouseenter', 'location-markers', []);
    window.__mapInstance._emitLayer('mouseleave', 'location-markers', []);
  });
  const cursor = await page.evaluate(() => window.__mapInstance.getCanvas().style.cursor);
  expect(cursor).toBe('');
});
