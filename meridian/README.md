# Meridian — Global Observatory Network

An interactive world map of ~30,000 climate monitoring stations and observatories. Pan, zoom, switch projections, toggle themes, search stations, browse a sortable table, and share any view or station via a URL or QR code.

---

## Running locally

No build step required. Serve the `meridian/` directory with any static file server:

```bash
# Python (built-in)
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# Caddy
caddy file-server --listen :8080
```

Then open `http://localhost:8080` in your browser.

**Note:** The app must be served over HTTP/HTTPS — opening `index.html` directly via `file://` will block the `fetch()` calls for JSON data.

---

## Adding new locations

### 1. Add an entry to `data/index.json`

Append to the `locations` array:

```json
{
  "id": "my-station",
  "name": "My Station",
  "lat": 51.5074,
  "lng": -0.1278,
  "category": "station",
  "country": "United Kingdom",
  "elevation_m": 25,
  "established": 1990,
  "network": "WMO / GHCN"
}
```

- `id`: kebab-case, unique. Used as the URL fragment and to locate the detail file.
- `category`: `"observatory"` or `"station"` — controls marker colour.
- `elevation_m`: numeric metres (used for sorting in the table).

### 2. Create a detail file at `data/locations/<id>.json`

```json
{
  "name": "My Station",
  "country": "United Kingdom",
  "elevation": "25m",
  "established": "1990",
  "type": "Surface Weather Station",
  "description": "A brief description of the station and its scientific role.",
  "variables": ["Temperature", "Precipitation", "Wind Speed"],
  "network": "WMO / GHCN"
}
```

If the detail file is absent, the app shows a graceful "No data available" fallback when the marker is clicked.

---

## No API token required

Meridian uses [MapLibre GL JS](https://maplibre.org/) (fully open-source) with [Carto free basemap styles](https://carto.com/basemaps/) — no account, no API key.

---

## URL hash format

Every view is bookmarkable. The URL hash encodes the current state:

| State | Format | Example |
|---|---|---|
| Map view | `#map=<zoom>/<lat>/<lng>/<projection>` | `#map=5.2/19.47/-155.59/globe` |
| Station selected | `#station=<id>` | `#station=mauna-loa` |
| Table view | `#table=<column>/<direction>` | `#table=elevation_m/desc` |

- Pasting a map URL into a new tab restores the exact viewport and projection.
- Pasting a station URL flies to that station and opens its detail panel.
- Pasting a table URL opens the table with the specified sort applied.
- Theme is stored in `localStorage`, not the URL — it is a personal preference, not part of the shared state.

---

## Deployment

The site is fully static — deploy the `meridian/` directory to any CDN or static host:

- **Cloudflare Pages**: connect the repo and set the build output to `meridian/`.
- **GitHub Pages**: push `meridian/` contents to a `gh-pages` branch (or configure Pages to serve from `/meridian`).
- **Netlify**: drag and drop the `meridian/` folder into the Netlify dashboard.

Ensure the host sends `Content-Encoding: gzip` for JSON files — all major CDNs do this automatically when gzip is enabled (it is by default). The raw `data/index.json` is ~4.5 MB but compresses to ~400–600 KB.

---

## Running tests

Tests use [Playwright](https://playwright.dev/). Install dependencies and run:

```bash
npm install
npx playwright test
```

The test suite intercepts CDN network calls (MapLibre, Google Fonts, QR library) so tests run offline without flakiness.
