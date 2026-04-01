# Meridian — Global Observatory Network

## Implementation Plan

A static website providing an interactive global map of ~30,000 monitoring stations and observatories. Users can zoom, pan, switch between Mercator and Globe projections, toggle light/dark themes, click locations for detail overlays, browse data source references, and switch to a sortable table view for browsing all locations.

Reference mockup: `map-explorer.jsx` (React artifact — use for visual/UX reference only, not as production code).

---

## Architecture

```
meridian/
├── index.html              # Entry point, loads app bundle
├── css/
│   └── style.css           # All styles (CSS variables for theming)
├── js/
│   ├── app.js              # Entry: bootstraps map, wires UI controls
│   ├── map.js              # Map rendering (Mapbox GL JS wrapper)
│   ├── markers.js          # Marker layer management, label visibility
│   ├── detail-panel.js     # Location detail overlay (fetch + render)
│   ├── sources-panel.js    # Data sources/references popover
│   ├── theme.js            # Light/dark mode toggle + persistence
│   ├── url-state.js        # Bidirectional URL hash ↔ app state sync
│   ├── qr.js               # QR code generation and display
│   └── table-view.js       # Sortable table view of all locations
├── data/
│   ├── index.json          # Location index (loaded on startup)
│   └── locations/
│       ├── mauna-loa.json  # Per-location detail files
│       ├── reykjavik.json
│       └── ...
├── assets/
│   └── favicon.svg
├── Makefile                 # Build orchestration
└── README.md
```

**No framework.** Vanilla JS + Mapbox GL JS. The site is fully static — no server, no build step beyond optional minification. All data is JSON fetched at runtime.

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Map renderer | Mapbox GL JS v3 | Vector tiles, native globe projection, smooth zoom/pan, free tier sufficient for static hosting |
| Styling | Plain CSS with custom properties | No build step, theme switching via class on `<html>` |
| JS | Vanilla ES modules | No bundler needed, `<script type="module">` works in all modern browsers |
| Fonts | Google Fonts (Playfair Display, Source Sans 3, JetBrains Mono) | Matches mockup typography |
| Hosting | Any static CDN (Cloudflare Pages, GitHub Pages, Netlify) | Zero server config |
| QR codes | qrcode-generator (CDN) | Tiny (~4KB), zero-dependency, generates SVG/canvas QR codes client-side |

---

## Data Schema

### `data/index.json`

```json
{
  "locations": [
    {
      "id": "mauna-loa",
      "name": "Mauna Loa Observatory",
      "lat": 19.4721,
      "lng": -155.5922,
      "category": "observatory",
      "country": "USA (Hawaii)",
      "elevation_m": 3397,
      "established": 1958,
      "network": "NOAA GML / WMO GAW"
    },
    {
      "id": "reykjavik",
      "name": "Reykjavík",
      "lat": 64.1466,
      "lng": -21.9426,
      "category": "station",
      "country": "Iceland",
      "elevation_m": 52,
      "established": 1949,
      "network": "WMO / GHCN"
    }
  ]
}
```

- `id`: kebab-case, used to derive detail file path: `data/locations/{id}.json`
- `category`: one of `"observatory"` | `"station"` — controls marker colour and table badge
- `elevation_m`: numeric metres (for sorting); the detail JSON has a formatted string version
- `established`: numeric year (for sorting)
- `country`, `network`: strings — displayed in table, sortable alphabetically

The index intentionally duplicates some fields from the per-location detail files so the table view can render and sort without fetching every detail file upfront.

---

## Scale: ~30,000 Locations

The dataset contains approximately 30,000 stations. This scale is manageable but requires deliberate choices to keep the app responsive. The following constraints shape the design across all phases:

### Index file size

30k locations × ~150 bytes each ≈ **4.5 MB JSON**. This is too large to serve raw.

**Mitigation:** Serve `index.json` gzipped. At this data shape, gzip compresses to roughly **400–600 KB** — acceptable for a one-time page load. Ensure the static host sends `Content-Encoding: gzip` (all major CDNs do this automatically). No need to split the file or paginate — one fetch, one parse, then everything is in memory.

**Alternative if gzip isn't sufficient:** Switch to a more compact format. Options in order of preference:
1. **Columnar JSON** — restructure as `{ ids: [...], names: [...], lats: [...], ... }` instead of array-of-objects. Same data, ~30% smaller because keys aren't repeated. Reconstruct objects client-side.
2. **MessagePack or CBOR** — binary JSON, ~40% smaller. Adds a decode dependency.
3. **Protobuf** — smallest but highest complexity. Overkill unless the dataset grows to 100k+.

Start with plain gzipped JSON. Only optimise the format if initial load time is a measured problem.

### Map markers (30k points)

Rendering 30k individual DOM elements or SVG circles would be catastrophic. Mapbox GL JS renders GeoJSON sources on the GPU via WebGL, so 30k points in a single GeoJSON source with a `circle` layer is **fine** — this is well within Mapbox's design envelope (it handles millions of points).

**Key requirements:**
- **Single GeoJSON source, not 30k individual markers.** The entire dataset is one `FeatureCollection` added as one source.
- **No HTML markers.** Use only Mapbox GL's native `circle` and `symbol` layers, which render on the GPU.
- **Clustering at low zoom.** At zoom levels 1–5, 30k overlapping dots are visual noise. Enable Mapbox's built-in clustering on the source: `cluster: true, clusterRadius: 50, clusterMaxZoom: 10`. Render clusters as circles with a count label. Unclustered points render as individual markers at higher zoom. This is a Mapbox-native feature — no custom code needed beyond configuration.
- **Label layer minzoom.** The `location-labels` symbol layer should have a high `minzoom` (e.g., 8–10). At lower zooms with clustering active, labels would overlap impossibly. Mapbox's collision detection will handle some of this, but setting a firm minzoom avoids the GPU cost entirely.

### Table view (30k rows)

Rendering 30k `<tr>` elements in the DOM is feasible but sluggish — initial render takes 200–500ms and scrolling can stutter on low-end devices.

**Mitigation: Virtual scrolling.** Only render the rows currently visible in the viewport (plus a small buffer above/below). This keeps the DOM size at ~50–80 rows regardless of dataset size.

**Implementation approach:**
- Calculate total scroll height from `rowCount × rowHeight` (use a fixed row height, e.g., 44px).
- Set `.table-body` container to this total height (creates the correct scrollbar size).
- On scroll, compute `startIndex = Math.floor(scrollTop / rowHeight)` and render only `visibleCount + buffer` rows, positioned absolutely via `transform: translateY(startIndex * rowHeight)`.
- This is a well-known pattern. Implement it from scratch (it's ~60 lines of code for a fixed-height case) or use a lightweight library. **No heavy dependencies** — avoid react-window, ag-grid, etc. since we're vanilla JS.
- The `<thead>` with sticky headers remains a real DOM element outside the virtual scroll container.

**Sorting at 30k:** `Array.prototype.sort` on 30k items is <10ms even with a comparator function. No optimisation needed — sort the in-memory array and re-render the visible window.

**Search/filter (recommended addition):** With 30k rows, a text filter input above the table becomes important. A simple `input` that filters the sorted array by substring match on name/country/network before passing to the virtual scroller. Filtering 30k strings is <5ms. This is not a separate phase — include it in the table view implementation.

### Detail file fetching

30k detail files means 30k individual JSON files on disk. This is fine for a static host — each is fetched on demand when a user clicks a specific station, and most will never be fetched in a single session. No preloading, no batching.

**CDN caching:** Set `Cache-Control: public, max-age=86400` (or longer) on the detail files so repeated views don't re-fetch.

### `data/locations/{id}.json`

```json
{
  "name": "Mauna Loa Observatory",
  "country": "USA (Hawaii)",
  "elevation": "3397m",
  "established": "1958",
  "type": "Atmospheric Baseline Observatory",
  "description": "Premier atmospheric research facility operated by NOAA...",
  "variables": ["CO₂", "CH₄", "N₂O", "O₃", "Solar Radiation"],
  "network": "NOAA GML / WMO GAW"
}
```

---

## Implementation Phases

### Phase 1 — Project Skeleton & Map

**Goal:** Mapbox GL JS rendering a styled globe with land/water colours, zoom controls, and pan. No markers yet.

**Tasks:**

1. Create directory structure as shown above.
2. Create `index.html`:
   - Load Google Fonts.
   - Load Mapbox GL JS v3 CSS + JS from CDN.
   - Load `css/style.css` and `js/app.js` (type=module).
   - HTML structure: header (logo + controls), map container div, zoom controls, footer bar.
3. Create `css/style.css`:
   - Define CSS custom properties for both themes under `[data-theme="dark"]` and `[data-theme="light"]` on `:root` / `html`.
   - Dark theme: deep ocean blues (#0a1628, #0f2847), muted land greens (#2d6b45), amber accents (#d4a855).
   - Light theme: warm parchment (#f4f0e8), soft ocean blues (#a8cce4), darker amber (#7a5f20).
   - Style all UI chrome: header, footer, zoom buttons, projection toggle, theme toggle.
   - Map container fills available viewport between header and footer.
4. Create `js/map.js`:
   - Initialise Mapbox GL JS map in the container div.
   - Use a style that renders land green and water blue (customise a Mapbox style or use `map.setPaintProperty` on a base style to override land/water fill colours to match the theme).
   - Set `projection: 'mercator'` as default; expose a function `setProjection('mercator' | 'globe')`.
   - Set `minZoom: 1` (cannot zoom out past full globe), `maxZoom: 16`.
   - On projection change, if switching to globe, set `projection: 'globe'`; if switching to mercator, set `projection: 'mercator'`. Mapbox GL v3 supports this natively via `map.setProjection()`.
   - Mercator wrapping is handled automatically by Mapbox (`renderWorldCopies: true` — this is the default).
5. Create `js/app.js`:
   - Import map.js, theme.js.
   - Wire projection toggle buttons to `map.setProjection()`.
   - Wire zoom +/- buttons to `map.zoomIn()` / `map.zoomOut()`.
   - Display current zoom level in the zoom indicator.
6. Create `js/theme.js`:
   - On load, check `localStorage` for saved theme; default to `'dark'`.
   - Toggle sets `document.documentElement.dataset.theme` and saves to localStorage.
   - Expose `getTheme()` and `toggleTheme()`.
   - When theme changes, also update Mapbox map paint properties (land fill, water fill, background) to match. Define colour sets for both themes.

**Acceptance criteria:**
- Page loads showing a styled map (correct land/water colours).
- Mercator ↔ Globe toggle works.
- Zoom +/- buttons and scroll wheel work; cannot zoom out past full globe.
- Pan works correctly (drag direction is intuitive).
- Light/dark toggle switches all UI chrome AND map colours.
- Mercator projection wraps horizontally.

---

### Phase 2 — Location Markers & Labels

**Goal:** Load location index, render markers on the map, show labels at sufficient zoom.

**Tasks:**

1. Create `data/index.json` with all location entries (use the 15 from the mockup as starter data; the production dataset will contain ~30k).
2. Create `js/markers.js`:
   - Fetch `data/index.json` on init. Store the parsed array in a shared module-level variable (other modules will need it — see Phase 5).
   - Convert locations array into a GeoJSON FeatureCollection (30k features).
   - Add a **clustered** source to the map:
     ```
     map.addSource('locations', {
       type: 'geojson',
       data: featureCollection,
       cluster: true,
       clusterRadius: 50,
       clusterMaxZoom: 10
     });
     ```
   - Add three layers:
     - `clusters`: circle layer filtered to `['has', 'point_count']`. Circle-radius scaled by `point_count` (step or interpolate expression). Fill colour uses a colour ramp (e.g., amber at low count → deeper amber at high count). A symbol layer on top shows the cluster count as text.
     - `location-markers`: circle layer filtered to `['!', ['has', 'point_count']]` (unclustered points only). Paint: circle-color driven by `category` property (observatory → `#5ca8c4` dark / `#1e6e90` light, station → `#d4a855` dark / `#7a5f20` light). Circle-radius interpolated by zoom (small at low zoom, larger when zoomed in). Circle-stroke for ring effect.
     - `location-labels`: symbol layer filtered to unclustered points. Text-field: `["get", "name"]`. Set `minzoom: 8` (labels only appear when zoomed in enough that clusters have dissolved). Text-font, size, colour, halo matching mockup. Text-offset to position labels beside markers. Mapbox's built-in collision detection (`text-allow-overlap: false`) prevents label stacking.
   - All layers respond to theme changes (update paint properties).
   - **Clicking a cluster**: zoom into it. Use `map.getSource('locations').getClusterExpansionZoom(clusterId)` to find the right zoom level, then `map.easeTo({ center, zoom })`.
3. Wire unclustered marker click:
   - `map.on('click', 'location-markers', (e) => { ... })` — extract feature `id`, pass to detail panel.
   - Change cursor to pointer on hover over markers and clusters.
4. Update footer stats to show location count from loaded index.

**Acceptance criteria:**
- All locations from index.json appear on the map (clustered at low zoom, individual at high zoom).
- Clusters show a count and expand on click.
- Observatory and station markers are visually distinct colours when unclustered.
- Labels appear only when zoomed in sufficiently (minzoom 8+).
- Markers and clusters change colour correctly when theme toggles.
- Clicking an unclustered marker triggers detail panel (Phase 4).
- Map remains smooth at 60fps with 30k points loaded.

---

### Phase 3 — URL State & QR Code

**Goal:** The URL hash always reflects the current view state. Any URL can be bookmarked, shared, or scanned via the on-screen QR code to restore the exact same view or selected station.

#### URL Hash Format

Three modes, determined by the current view:

```
# Map view (no station selected):
https://example.com/#map=<zoom>/<lat>/<lng>/<projection>

# Station selected (detail panel open):
https://example.com/#station=<location-id>

# Table view:
https://example.com/#table=<sort-column>/<sort-direction>

Examples:
  /#map=5.2/19.47/-155.59/globe
  /#station=mauna-loa
  /#table=name/asc
  /#table=elevation_m/desc
```

**Design decisions:**
- Map view hash encodes zoom (1 decimal), centre lat/lng (2 decimals), and projection. This is sufficient to recreate the viewport.
- Station hash is just the location ID. When restoring, the map flies to the station's coordinates (looked up from the index) and opens the detail panel. The projection and zoom are set to sensible defaults (zoom 8, current projection preserved). Works from both map and table views.
- Table hash encodes the current sort column and direction. When restoring, the app switches to table view with the specified sort applied.
- Theme is NOT in the URL — it's a user preference stored in localStorage, not part of the shareable state.
- When no hash is present, the app loads with the default view (map mode, zoom 1, centre 0/0, mercator).

#### Tasks

1. Create `js/url-state.js`:
   - **`serialiseMapState(map, projection)`** → returns hash string like `map=5.2/19.47/-155.59/globe`.
   - **`serialiseStationState(locationId)`** → returns hash string like `station=mauna-loa`.
   - **`serialiseTableState(sortColumn, sortDirection)`** → returns hash string like `table=name/asc`.
   - **`parseHash(hash)`** → returns `{ type: 'map', zoom, lat, lng, projection }` or `{ type: 'station', id }` or `{ type: 'table', sortColumn, sortDirection }` or `null`.
   - **`pushState(hashString)`** → calls `history.replaceState(null, '', '#' + hashString)`. Use `replaceState` not `pushState` to avoid polluting browser history on every pan/zoom.
   - **`onHashChange(callback)`** → listens for `hashchange` events (user navigates back/forward or edits URL).

2. Wire state serialisation (in `app.js`):
   - **Map movement → URL**: On Mapbox `moveend` event (fires after pan/zoom completes), if no station is selected, call `pushState(serialiseMapState(...))`. Debounce by 300ms to avoid thrashing during continuous interaction.
   - **Station selection → URL**: When `openDetail(id)` is called, call `pushState(serialiseStationState(id))`.
   - **Station close → URL**: When `closeDetail()` is called, serialise the current map viewport back to the URL.

3. Wire state restoration (in `app.js`):
   - **On page load**: Parse `window.location.hash`. If it's a map hash, call `map.jumpTo({ center, zoom })` and `map.setProjection()`. If it's a station hash, look up the location in the index, fly the map to it, and call `openDetail(id)`. If it's a table hash, switch to table view and apply the specified sort.
   - **On hashchange**: Same parsing + restoration logic. This handles browser back/forward navigation.

4. Create `js/qr.js`:
   - Load `qrcode-generator` library from CDN (`https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`).
   - **`renderQR(url, containerElement, size)`**: Generates a QR code as an SVG and inserts it into the given container. Size in px (default 120). QR colours should respect the current theme (dark modules on light bg in light mode, light modules on dark bg in dark mode).
   - **`updateQR(url)`**: Updates the existing QR code with a new URL without recreating the DOM element (swap the SVG content).

5. QR code display — three placements:
   - **Map view QR** (no station selected): A small QR code (100×100px) in the bottom-left corner of the map, above the coordinate display. Shows the current URL (updates on debounced `moveend`). Styled with the same panel background/border treatment as other UI chrome. Subtle — not visually dominant.
   - **Detail panel QR** (station selected): A QR code (120×120px) inside the detail panel, below the variable tags section. Shows the station URL (`#station=<id>`). Labelled "Share this station" in small text beneath.
   - **Table view QR**: A small QR code (100×100px) in the bottom-right corner of the table view. Shows the current table URL including sort state. Labelled "Share this view".

6. CSS additions:
   - `.qr-container`: positioned absolute bottom-left on the map, above `.coord-display`. Panel background, rounded corners, padding. Includes a tiny "Share view" label beneath the QR.
   - `.detail-qr`: centred within the detail panel footer area, with "Share this station" label.
   - Both QR containers should transition smoothly when the URL updates (no flash/jank).

**Acceptance criteria:**
- Panning/zooming the map updates the URL hash (debounced, no history spam).
- Selecting a station updates the URL hash to `#station=<id>`.
- Closing a station restores the map view hash.
- Pasting a map-view URL into a new tab restores the exact viewport and projection.
- Pasting a station URL into a new tab loads the map, flies to the station, and opens the detail panel.
- Pasting a table URL into a new tab opens the table view with the specified sort applied.
- Browser back/forward navigates between viewed stations, map positions, and table view.
- A QR code is visible on the map (bottom-left) encoding the current URL; it updates as the view changes.
- A QR code is visible inside the detail panel encoding the station URL.
- QR codes are scannable and resolve to the correct URL.
- QR colours adapt to the current theme.

---

### Phase 4 — Detail Panel Overlay

**Goal:** Clicking a location shows a modal overlay with details fetched from the location's JSON file.

**Tasks:**

1. Create sample `data/locations/*.json` files for at least 4 locations (Mauna Loa, Reykjavík, Cape Grim, South Pole — use mockup data).
2. Create `js/detail-panel.js`:
   - Expose `openDetail(locationId)` and `closeDetail()`.
   - `openDetail`:
     - Show overlay backdrop (semi-transparent + backdrop-filter blur).
     - Show panel container with loading shimmer animation.
     - Fetch `data/locations/${locationId}.json`.
     - On success, render: type badge, name (Playfair Display), metadata grid (country, elevation, established, network), divider, description paragraph, variable tags, and a QR code section (see Phase 3) showing the shareable station URL.
     - On error (404 for locations without detail files), show a graceful "No data available" message.
   - `closeDetail`: hide overlay. Triggered by clicking backdrop, clicking × button, or pressing Escape. Must also update the URL hash back to the current map view (see Phase 3).
   - Panel styled to match mockup: rounded corners, border, box-shadow, slide-up animation.
3. Wire to marker click from Phase 2.

**Acceptance criteria:**
- Clicking a marker with a detail file shows the overlay with correct data.
- Loading shimmer displays while fetching.
- Clicking a marker without a detail file shows graceful fallback.
- Overlay closes on backdrop click, × button, and Escape key.
- Panel respects current theme.
- Panel includes a scannable QR code linking to the station URL.
- Opening/closing the panel correctly updates the URL hash.

---

### Phase 5 — Table View

**Goal:** An alternative browse mode showing all locations in a sortable table. Users can switch between map and table views. Clicking a row opens the same detail panel used by the map.

#### Layout

The table view replaces the map — it is not an overlay. The header, footer, and theme toggle remain. The map container is hidden and a table container is shown in its place. A view-mode toggle in the header (next to the projection toggle) switches between Map and Table.

When table view is active, the projection toggle (Mercator/Globe) is hidden since it's irrelevant. The zoom controls are also hidden.

#### Table Columns

| Column | Sort type | Default direction | Notes |
|---|---|---|---|
| Name | alphabetical | asc | Primary default sort |
| Category | alphabetical | asc | Shows "Observatory" / "Station" as a coloured badge |
| Country | alphabetical | asc | |
| Latitude | numeric | desc | Formatted to 2 decimal places, with N/S suffix |
| Longitude | numeric | asc | Formatted to 2 decimal places, with E/W suffix |
| Elevation | numeric | desc | Formatted with "m" suffix and comma separators |
| Established | numeric | asc | Year only |
| Network | alphabetical | asc | |

#### Tasks

1. Create `js/table-view.js`:
   - Expose `showTable()`, `hideTable()`, `isTableVisible()`.
   - `showTable()`:
     - Hide the map container, zoom controls, coordinate display, and map QR code.
     - Show the table container.
     - Render the location index using **virtual scrolling** (see Scale section). Only the visible rows plus a buffer are in the DOM at any time.
     - Apply current sort state (default: Name ascending).
     - Update URL hash to `#table=<sortColumn>/<sortDirection>`.
   - `hideTable()`:
     - Hide the table container.
     - Show the map container and associated controls.
     - Trigger a Mapbox `map.resize()` (required after the container was hidden).
     - Update URL hash back to the current map state.

   - **Virtual scrolling implementation:**
     - Use a fixed row height (44px). Total scroll height = `filteredCount × 44`.
     - The table container has two parts: a real `<thead>` (sticky, always in DOM) and a `.table-body` scroll container.
     - `.table-body` has an inner spacer div set to the total height (creates correct scrollbar).
     - On scroll, compute `startIndex = Math.floor(scrollTop / rowHeight)`, render `visibleCount + 20` rows (10 buffer each side) using absolute positioning via `transform: translateY(...)`.
     - On sort or filter change, reset scroll to top and re-render the visible window.
     - This keeps the DOM at ~50–80 `<tr>` elements regardless of dataset size.

   - **Search/filter:**
     - A text input above the table, styled to match the theme (panel background, amber focus ring).
     - Filters the sorted array by case-insensitive substring match on `name`, `country`, and `network` fields.
     - Debounce input by 150ms to avoid re-filtering on every keystroke.
     - Show a result count (e.g., "1,247 of 30,000 stations").
     - Filter is applied before virtual scrolling — the scroller only sees the filtered subset.
     - Clearing the filter restores the full dataset.

   - **Sorting**:
     - Each column header is clickable.
     - Clicking an unsorted column sorts ascending (or its default direction from the table above).
     - Clicking the currently sorted column toggles direction.
     - Active sort column shows an arrow indicator (▲ / ▼).
     - Sorting is done client-side on the in-memory array (~30k items sorts in <10ms).
     - After sorting, update the URL hash with new sort state and reset the virtual scroller.
   - **Row rendering**:
     - Each row shows all columns from the index data.
     - Category column renders as a small coloured badge (same colours as map markers).
     - Latitude: positive → "N", negative → "S". Longitude: positive → "E", negative → "W".
     - Elevation: formatted with locale number separators + "m" suffix.
     - Row is clickable — entire row acts as a click target.
     - Hover state: subtle background highlight.
   - **Row click**:
     - Opens the detail panel (same `openDetail(id)` from Phase 4).
     - URL updates to `#station=<id>`.
     - When the detail panel closes, returns to table view (not map view). This requires `closeDetail()` to know which view mode was active. Pass the active view mode as context, or store it in a simple module-level variable.
   - **"Show on map" action**:
     - Each row has a small icon/button that switches to map view and flies to that location, without opening the detail panel.
     - This gives users a way to locate a station spatially from the table.

2. Add view-mode toggle to header:
   - New toggle group alongside the projection toggle: `Map | Table`.
   - Styled identically to the projection toggle (same `.projection-toggle` pattern, or rename to `.view-toggle`).
   - Map button: switches to map view, shows projection toggle.
   - Table button: switches to table view, hides projection toggle.

3. CSS additions for table view:
   - `.table-container`: takes the same space as `.map-container` (flex: 1, overflow-y: auto). Padding for comfortable reading.
   - `table`: full width, border-collapse, themed with CSS variables.
   - `th`: sticky header row (`position: sticky; top: 0`), same panel background. Cursor pointer. Sort indicator arrow. Hover highlight.
   - `td`: padding, border-bottom using the divider colour variable. Monospace font for numeric columns (lat, lng, elevation, year).
   - `tr:hover`: subtle background highlight (amber tint at low opacity).
   - `.category-badge`: small rounded pill, coloured by category (same observatory/station colours).
   - `.show-on-map-btn`: small, subtle icon button within each row.
   - Responsive: on viewports < 768px, hide less important columns (Longitude, Network) to avoid horizontal scroll. Or use horizontal scroll with a visual indicator.

4. Update `js/app.js`:
   - Wire view-mode toggle to `showTable()` / `hideTable()`.
   - On page load, if hash is `#table=...`, call `showTable()` and apply the sort from the hash.
   - Track current view mode (`'map'` | `'table'`) so detail panel close returns to the correct view.

**Acceptance criteria:**
- Clicking "Table" in the header switches to a full table of all locations.
- All columns from the index are displayed with correct formatting.
- Virtual scrolling keeps DOM size constant — scrolling 30k rows is smooth at 60fps.
- Search input filters by name/country/network with result count displayed.
- Clicking any column header sorts the table; clicking again reverses direction.
- Active sort column shows a directional arrow.
- Sort and filter state is reflected in the URL hash.
- Clicking a row opens the detail panel; closing it returns to the table.
- "Show on map" button switches to map view and flies to the location.
- Switching back to Map view restores the map correctly (no rendering glitches).
- Table respects the current theme.
- Pasting a `#table=elevation_m/desc` URL opens the table sorted by elevation descending.
- Initial table render from 30k rows takes <100ms.

---

### Phase 6 — Sources & References Panel

**Goal:** Footer button opens a popover panel listing data sources and algorithm references.

**Tasks:**

1. Create `js/sources-panel.js`:
   - Expose `toggleSources()`.
   - Renders a popover anchored to bottom-right, above the footer.
   - Content is hardcoded HTML (these are static references, not fetched):
     - **Observational Networks**: NOAA GML, WMO GAW, GHCN v4.
     - **Reanalysis & Gridded Products**: ERA5, GISTEMP v4.
     - **Algorithms & Methodology**: PHA (Menne & Williams 2009), TOB (Karl et al. 1986), USHCNv2.5 (Menne et al. 2009).
   - Each entry: name, short description, URL (where applicable).
   - Panel has a close button and dismisses on outside click.
   - Slide-up animation matching detail panel.
   - Sources panel works in both map and table view modes.
2. Wire footer "Data Sources & References" button to `toggleSources()`.

**Acceptance criteria:**
- Button toggles the sources panel open/closed.
- Panel lists all sources and references with correct citations.
- Clicking outside the panel or the close button dismisses it.
- Panel respects current theme.

---

### Phase 7 — Polish & Responsive

**Goal:** Final visual polish, responsive behaviour, accessibility, and performance.

**Tasks:**

1. **Responsive layout:**
   - On viewports < 768px: header stacks vertically (logo above controls), zoom controls shrink, sources panel goes full-width, detail panel goes near-full-width.
   - Table view on viewports < 768px: hide Longitude and Network columns; use horizontal scroll with a fade-edge indicator if needed.
   - QR code on the map hides on viewports < 480px (screen too small to be useful; detail panel QR still shows).
   - Touch: ensure pan/zoom works on mobile (Mapbox handles this natively).
2. **Accessibility:**
   - All buttons have `aria-label`.
   - Detail panel traps focus when open, restores on close.
   - Overlay is `role="dialog"` with `aria-modal="true"`.
   - Theme toggle announces state change via `aria-live`.
   - Table: sortable column headers use `aria-sort="ascending"` / `"descending"` / `"none"`. Table rows are keyboard-navigable (Enter to open detail).
   - Sufficient colour contrast in both themes (check with axe or Lighthouse).
3. **Performance (critical at 30k scale):**
   - Preconnect to Google Fonts and Mapbox CDN in `<head>`.
   - `data/index.json` is ~4.5MB raw, ~500KB gzipped. Fetch on DOMContentLoaded. Show a loading indicator until the index is parsed and the map source is ready.
   - Parse the index JSON in a single `JSON.parse` call (fast, ~50ms for 4.5MB). Do NOT stream-parse or chunk — the browser's native parser is the fastest path.
   - Detail JSON files are small; fetch on demand with `Cache-Control` headers for repeat views.
   - Map: verify 60fps pan/zoom with 30k-point clustered source. Profile on a mid-range device (e.g., 2020 MacBook Air or equivalent). If frame drops occur, reduce `clusterRadius` or increase `clusterMaxZoom`.
   - Table: verify virtual scroller handles rapid scrolling without blank flashes. Buffer size of 10 rows above/below should suffice; increase if testing reveals gaps.
   - QR code generation is synchronous and fast (~1ms); no performance concern.
   - Consider adding a simple fade-in on initial map load to mask the index fetch time.
4. **Favicon:** Create a simple SVG favicon (small globe icon matching the logo).
5. **README.md:**
   - Project description.
   - How to run locally (just serve the directory — `python -m http.server` or similar).
   - How to add new locations (add to index.json + create detail JSON).
   - Mapbox token setup (required — document where to set it).
   - URL hash format documentation (how bookmarkable URLs work).
   - Deployment instructions.

**Acceptance criteria:**
- Looks good on desktop (1920×1080) and mobile (375×812).
- Lighthouse accessibility score ≥ 90.
- No console errors.
- README is complete.
- Bookmarkable URLs work end-to-end (copy URL → new tab → same state).

---

## Notes for the Implementer

1. **Mapbox token**: You'll need a Mapbox access token. Add it as a constant at the top of `js/map.js` or load from a `config.js`. For a static site this is necessarily public, which is fine — use Mapbox URL restrictions to lock it to your domain.

2. **Map style colours**: The simplest approach is to start with `mapbox://styles/mapbox/dark-v11` for dark mode and `mapbox://styles/mapbox/light-v11` for light mode, then override the land and water paint properties via `map.setPaintProperty()`. Alternatively create custom styles in Mapbox Studio.

3. **Theme switching the map**: When the user toggles theme, call `map.setStyle(newStyleUrl)` and re-add the location source/layers after `style.load` fires. This is cleaner than patching dozens of paint properties individually.

4. **Zoom-to-label mapping**: The mockup uses "2× zoom" as the label threshold. In Mapbox GL terms, this maps to roughly zoom level 3–4 for a full-window map. Set `location-labels` layer `minzoom` accordingly and tune by eye.

5. **The mockup's rough continent rendering** (bounding-box land detection) is only for the SVG prototype. Mapbox provides actual vector tile coastlines — you don't need any of that logic.

6. **Data scale**: The production dataset contains ~30,000 locations. The 15 mock locations and 4 detail files are for development. The index schema and all rendering paths must be tested against the full dataset before shipping. Generate a synthetic 30k-entry `index.json` for development testing if the real data isn't available yet (random lat/lng, realistic names, mixed categories).

7. **URL hash — `replaceState` not `pushState`**: Map panning generates many `moveend` events. Using `history.pushState` would create hundreds of history entries and break the back button. Use `history.replaceState` for map movement updates. Only use `pushState` (or equivalent) when the user explicitly selects/deselects a station, so that back/forward navigates between stations.

8. **URL hash — debounce `moveend`**: Mapbox fires `moveend` frequently during animated transitions (flyTo, easeTo). Debounce hash updates by 300ms so we only serialise the final resting position.

9. **URL hash — page load race condition**: On initial load, you need the location index to be loaded before you can restore a `#station=<id>` hash (to look up lat/lng). Sequence: fetch index → parse hash → restore state. Don't initialise hash listeners until the index is loaded.

10. **QR code library**: Use `qrcode-generator` from CDN (`https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js`). It's ~4KB, generates QR matrices synchronously, and can output SVG cell-by-cell or as a data URI. For cleanest rendering, generate the QR matrix and build an SVG manually using `<rect>` elements — this gives full control over module colours for theme switching.

11. **QR code — URL length**: Hash URLs are short (max ~60 chars for `#map=5.2/19.47/-155.59/globe`). QR version 2–3 handles this easily at error correction level M. Don't over-specify the QR version; let the library auto-select.

12. **QR code — visual subtlety**: The map-view QR should be unobtrusive. Use low opacity (0.7) at rest, full opacity on hover. Match the panel chrome styling (same background, border, border-radius). The detail panel QR can be more prominent since it's an explicit sharing affordance.

13. **Table view — shared data**: The location index fetched by `markers.js` is the same data the table needs. Don't fetch it twice. Export the loaded array from a shared module or store it in a simple app-level state object that both `markers.js` and `table-view.js` import.

14. **Table view — sort stability**: Use a stable sort so that rows with equal values in the sorted column maintain their relative order. `Array.prototype.sort` is stable in all modern browsers (ES2019+), so no polyfill needed.

15. **Table view — detail panel return context**: When the detail panel opens from a table row click, it needs to return to table view on close (not map view). The simplest approach: store a `viewModeBeforeDetail` variable. `openDetail` saves the current mode; `closeDetail` restores it.

16. **Table view — Mapbox resize**: When switching from table back to map, the map container was `display: none`. Mapbox GL requires `map.resize()` after the container becomes visible again, otherwise the canvas dimensions are wrong. Call it in a `requestAnimationFrame` after showing the container to ensure the DOM has updated.

17. **Table view — "Show on map"**: This button should use `pushState` (not `replaceState`) so the user can press Back to return to the table. The sequence: push `#map` hash → switch to map view → `map.flyTo({ center: [lng, lat], zoom: 8 })`.

18. **Clustering — theme switching**: When `map.setStyle()` is called for a theme change, all sources and layers are removed. After `style.load` fires, re-add the clustered source and all three layers (clusters, markers, labels). The GeoJSON data is already in memory — no re-fetch needed, just `map.addSource(...)` again.

19. **Clustering — click disambiguation**: At some zoom levels, an unclustered marker may sit on top of a cluster. Handle clicks by checking both layers: prefer unclustered marker clicks (open detail) over cluster clicks (zoom in). Use `map.queryRenderedFeatures(point, { layers: ['location-markers'] })` first, fall back to querying the `clusters` layer.

20. **Virtual scroller — accessibility**: The virtual scroller hides most rows from the DOM, which can confuse screen readers. Add `role="grid"` and `aria-rowcount="30000"` on the table, and `aria-rowindex` on each rendered row. This tells assistive technology about the full dataset even though only a subset is in the DOM.

21. **Index loading indicator**: With a ~500KB gzipped fetch, there will be a noticeable pause (0.5–2s on typical connections). Show a minimal loading state: the map container with a centred spinner or progress bar, and disable the Table toggle until data is ready. Don't show an empty map with zero markers — that looks broken.
