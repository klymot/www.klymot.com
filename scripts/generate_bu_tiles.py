#!/usr/bin/env python3
"""
Generate built-up (BU) sprite tiles for all stations in docs/data/index.json.

Run once per epoch year (default: 2020).  Each run:
  • Extracts a 20×20 km thumbnail from the GHSL built-up raster for that year.
  • Colours it with the orwell2024/builtmap 8-stop palette.
  • Stitches all thumbnails into a single PNG sprite sheet:
      docs/assets/bu_{year}_sprite.png
  • Computes bu_{year}_1km, bu_{year}_5km, bu_{year}_20km percentage scores and
    writes them back into index.json alongside a bu_{year}_idx field and a root-
    level bu_{year}_sprite descriptor.
  • After writing the year's data, recomputes bu_change (= bu_2020_5km −
    bu_1975_5km) for every station that has both years present.

GHSL data
---------
By default the script auto-downloads the requested year's zip (~3 GB) from the
JRC FTP mirror and caches it under .cache/.  An ETag file is stored alongside the
zip so subsequent runs only re-download if the remote file has changed.  Supply
--ghsl to point at an already-extracted .tif and skip the download entirely.

Supported years: 1975, 1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020
(all available in the GHS_BUILT_S_GLOBE_R2023A release).

For faster random access, convert the extracted tif to a Cloud Optimised GeoTIFF:
  gdal_translate -of COG -co COMPRESS=LZW \\
      .cache/GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0.tif \\
      .cache/GHS_BUILT_S_E2020_cog.tif

Usage
-----
  # Generate 2020 sprite (auto-downloads GHSL E2020 data)
  python3 scripts/generate_bu_tiles.py
  python3 scripts/generate_bu_tiles.py --ghsl .cache/GHS_BUILT_S_E2020_cog.tif

  # Generate 1975 sprite
  python3 scripts/generate_bu_tiles.py --year 1975 --ghsl GHS_BUILT_S_E1975_GLOBE_R2023A_54009_100/GHS_BUILT_S_E1975_GLOBE_R2023A_54009_100_V1_0.tif

  GHSL_TIF=/data/GHS_BUILT_S_E2020.tif python3 scripts/generate_bu_tiles.py
"""

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from pyproj import Transformer

if __package__ in (None, ''):
    sys.path.append(str(Path(__file__).resolve().parent))
    from json_utils import write_sorted_json
else:
    from .json_utils import write_sorted_json

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT  = Path(__file__).resolve().parent.parent
INDEX_PATH = REPO_ROOT / 'docs' / 'data' / 'index.json'
CACHE_DIR  = REPO_ROOT / '.cache'

# ── Year configuration ────────────────────────────────────────────────────────

YEAR_CONFIG = {
    # label → (ghsl_epoch, default_tif_stem)
    '2020': ('2020', 'GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0'),
    '1975': ('1975', 'GHS_BUILT_S_E1975_GLOBE_R2023A_54009_100_V1_0'),
    '1980': ('1980', 'GHS_BUILT_S_E1980_GLOBE_R2023A_54009_100_V1_0'),
    '1985': ('1985', 'GHS_BUILT_S_E1985_GLOBE_R2023A_54009_100_V1_0'),
    '1990': ('1990', 'GHS_BUILT_S_E1990_GLOBE_R2023A_54009_100_V1_0'),
    '1995': ('1995', 'GHS_BUILT_S_E1995_GLOBE_R2023A_54009_100_V1_0'),
    '2000': ('2000', 'GHS_BUILT_S_E2000_GLOBE_R2023A_54009_100_V1_0'),
    '2005': ('2005', 'GHS_BUILT_S_E2005_GLOBE_R2023A_54009_100_V1_0'),
    '2010': ('2010', 'GHS_BUILT_S_E2010_GLOBE_R2023A_54009_100_V1_0'),
    '2015': ('2015', 'GHS_BUILT_S_E2015_GLOBE_R2023A_54009_100_V1_0'),
    '2020': ('2020', 'GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0'),
}

_JRC_BASE = (
    'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/'
    'GHS_BUILT_S_GLOBE_R2023A/'
)

# ── Colour palette (matches orwell2024/builtmap) ───────────────────────────────
# (threshold_percent, (R, G, B))  — values are built-up % 0–100
PALETTE = [
    ( 0.0, (  8,  48, 107)),
    ( 0.3, ( 29,  78, 137)),
    ( 1.0, ( 33, 113, 181)),
    ( 2.0, ( 86, 177, 247)),
    ( 3.0, (247, 209,  61)),
    ( 6.0, (248, 150,  30)),
    (12.0, (220,  47,   2)),
    (50.0, (157,   2,   8)),
]

# ── Constants ──────────────────────────────────────────────────────────────────

GHSL_RES  = 100                          # native resolution, metres
HALF_M    = 10_000                       # half of 20 km box
NATIVE_PX = int(2 * HALF_M / GHSL_RES)  # 200 px per side

# ── GHSL download / cache ─────────────────────────────────────────────────────

def _ghsl_paths(stem: str) -> tuple[Path, Path, Path, str]:
    """Return (tif_path, zip_path, etag_path, download_url) for a GHSL stem."""
    tif  = CACHE_DIR / (stem + '.tif')
    zp   = CACHE_DIR / (stem + '.zip')
    etag = CACHE_DIR / (stem + '.zip.etag')
    # Derive epoch from stem, e.g. GHS_BUILT_S_E2020_... → E2020_...
    # URL pattern: .../GHS_BUILT_S_E{epoch}_GLOBE_R2023A_54009_100/V1-0/{zip}
    epoch_dir = '_'.join(stem.split('_')[:6])   # GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100  ... actually let's parse properly
    # stem = GHS_BUILT_S_E{epoch}_GLOBE_R2023A_54009_100_V1_0
    parts    = stem.split('_')
    epoch    = parts[4]          # e.g. E2020 → full token 'E2020'
    dir_name = '_'.join(parts[:8])  # GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100
    url      = f'{_JRC_BASE}{dir_name}/V1-0/{stem}.zip'
    return tif, zp, etag, url


def _ensure_ghsl(stem: str) -> Path:
    """Ensure the GHSL tif is in .cache/, auto-downloading if necessary."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tif, zip_path, etag_file, url = _ghsl_paths(stem)

    if tif.exists():
        stored_etag = etag_file.read_text().strip() if etag_file.exists() else ''
        headers = {'If-None-Match': stored_etag} if stored_etag else {}
        req = urllib.request.Request(url, headers=headers)
        try:
            resp = urllib.request.urlopen(req)
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                print('GHSL: cached file is current (ETag match).')
                return tif
            raise
        if resp.status == 304:
            print('GHSL: cached file is current (ETag match).')
            resp.close()
            return tif
        print('GHSL: remote has changed, re-downloading...')
        _download_and_extract(resp, zip_path, etag_file, tif)
    else:
        print(f'GHSL: not found in cache, downloading (~3 GB)...')
        print(f'      {url}')
        resp = urllib.request.urlopen(urllib.request.Request(url))
        _download_and_extract(resp, zip_path, etag_file, tif)

    return tif


def _download_and_extract(resp, zip_path: Path, etag_file: Path, tif_out: Path) -> None:
    etag        = resp.headers.get('ETag', '')
    total_bytes = int(resp.headers.get('Content-Length', 0))
    downloaded  = 0

    with open(zip_path, 'wb') as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
            downloaded += len(chunk)
            if total_bytes:
                pct = downloaded / total_bytes * 100
                print(f'\r  {downloaded / 1e9:.2f} / {total_bytes / 1e9:.2f} GB  ({pct:.0f}%)',
                      end='', flush=True)
    print()

    if etag:
        etag_file.write_text(etag)

    print('Extracting tif from zip...')
    with zipfile.ZipFile(zip_path) as zf:
        tif_members = [m for m in zf.namelist() if m.endswith('.tif')]
        if not tif_members:
            raise RuntimeError(f'No .tif found inside {zip_path}')
        member = tif_members[0]
        print(f'  {member}  →  {tif_out}')
        with zf.open(member) as src, open(tif_out, 'wb') as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)
    print('Extraction complete.')

# ── LUT build (vectorised colour mapping) ─────────────────────────────────────

def _palette_color(pct: float) -> tuple:
    pct = max(0.0, min(100.0, float(pct)))
    if pct <= PALETTE[0][0]:
        return PALETTE[0][1]
    for i in range(1, len(PALETTE)):
        t0, c0 = PALETTE[i - 1]
        t1, c1 = PALETTE[i]
        if pct <= t1:
            f = (pct - t0) / (t1 - t0)
            return tuple(int(round(c0[j] + f * (c1[j] - c0[j]))) for j in range(3))
    return PALETTE[-1][1]


def _build_lut() -> np.ndarray:
    lut = np.zeros((10_001, 3), dtype=np.uint8)
    for v in range(10_001):
        lut[v] = _palette_color(v / 100.0)
    return lut


_LUT: np.ndarray | None = None

# ── Tile rendering ─────────────────────────────────────────────────────────────

def _render_tile(data_raw: np.ndarray, cell: int) -> Image.Image:
    """Convert raw GHSL values → coloured cell×cell RGB image."""
    global _LUT
    if _LUT is None:
        _LUT = _build_lut()

    idx = np.clip(data_raw.astype(np.int32), 0, 10_000)
    rgb = _LUT[idx].copy()

    img = Image.fromarray(rgb, 'RGB')
    if cell != NATIVE_PX:
        img = img.resize((cell, cell), Image.LANCZOS)
    return img


def _no_data_tile(cell: int) -> Image.Image:
    img  = Image.new('RGB', (cell, cell), (30, 30, 30))
    draw = ImageDraw.Draw(img)
    c    = cell // 2
    arm  = max(3, cell // 8)
    draw.line([(c - arm, c - arm), (c + arm, c + arm)], fill=(80, 80, 80), width=1)
    draw.line([(c + arm, c - arm), (c - arm, c + arm)], fill=(80, 80, 80), width=1)
    return img

# ── Score helpers ──────────────────────────────────────────────────────────────

def _bu_score(data_raw: np.ndarray, radius_km: float) -> float:
    """Mean built-up % within a circle of radius_km centred on the native tile."""
    h, w   = data_raw.shape
    cy, cx = h / 2.0, w / 2.0
    r_px   = radius_km * 1000.0 / GHSL_RES
    ys, xs = np.ogrid[:h, :w]
    mask   = (ys - cy) ** 2 + (xs - cx) ** 2 <= r_px ** 2
    vals   = data_raw[mask].astype(np.float64)
    # raw value is m² built-up per 100 m² pixel; /100 → %
    return float(vals.mean() / 100.0) if vals.size > 0 else 0.0

# ── Change computation ────────────────────────────────────────────────────────

def _compute_change(locations: list) -> int:
    """
    Compute bu_change = bu_2020_5km − bu_1975_5km for stations that have both.
    Returns the count of stations updated.
    """
    updated = 0
    for loc in locations:
        v2020 = loc.get('bu_2020_5km')
        v1975 = loc.get('bu_1975_5km')
        if v2020 is not None and v1975 is not None:
            loc['bu_change'] = round(v2020 - v1975, 3)
            updated += 1
        # Remove stale change if one year is now missing
        elif 'bu_change' in loc:
            del loc['bu_change']
    return updated

# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Generate BU sprite tiles from GHSL built-up surface data.'
    )
    parser.add_argument(
        '--year',
        default='2020',
        choices=sorted(YEAR_CONFIG),
        help='Epoch year for output columns and sprite file (default: 2020)',
    )
    parser.add_argument(
        '--ghsl',
        default=os.environ.get('GHSL_TIF'),
        metavar='PATH',
        help='Path to pre-extracted GHSL .tif (or set GHSL_TIF env var). Omit to auto-download.',
    )
    parser.add_argument(
        '--cell', type=int, default=32,
        help='Cell size in pixels per station thumbnail (default 32)',
    )
    parser.add_argument(
        '--cols', type=int, default=128,
        help='Number of columns in the sprite grid (default 128)',
    )
    args = parser.parse_args()

    year  = args.year
    cell  = args.cell
    cols  = args.cols
    ghsl_epoch, ghsl_stem = YEAR_CONFIG[year]

    sprite_out = REPO_ROOT / 'docs' / 'assets' / f'bu_{year}_sprite.png'
    idx_key    = f'bu_{year}_idx'
    key_1km    = f'bu_{year}_1km'
    key_5km    = f'bu_{year}_5km'
    key_20km   = f'bu_{year}_20km'
    sprite_key = f'bu_{year}_sprite'

    # Resolve GHSL path
    if args.ghsl:
        ghsl_path = Path(args.ghsl)
        if not ghsl_path.exists():
            print(f'ERROR: GHSL file not found: {ghsl_path}', file=sys.stderr)
            sys.exit(1)
    else:
        ghsl_path = _ensure_ghsl(ghsl_stem)

    with open(INDEX_PATH) as fh:
        index = json.load(fh)

    locations = index['locations']
    n    = len(locations)
    rows = math.ceil(n / cols)

    sprite_w = cols * cell
    sprite_h = rows * cell
    print(f'Year     : {year} (GHSL epoch {ghsl_epoch})')
    print(f'Stations : {n}')
    print(f'Grid     : {cols} cols × {rows} rows  ({sprite_w} × {sprite_h} px)')
    print(f'Cell     : {cell} px')
    print(f'GHSL     : {ghsl_path}')
    print(f'Sprite   : {sprite_out}')
    print()

    sprite  = Image.new('RGB', (sprite_w, sprite_h), (15, 15, 15))
    to_moll = Transformer.from_crs('EPSG:4326', 'ESRI:54009', always_xy=True)

    with rasterio.open(ghsl_path) as src:
        nodata = src.nodata

        for i, loc in enumerate(locations):
            col_idx = i % cols
            row_idx = i // cols

            lat, lng = loc['lat'], loc['lng']
            x_m, y_m = to_moll.transform(lng, lat)

            left   = x_m - HALF_M
            right  = x_m + HALF_M
            bottom = y_m - HALF_M
            top    = y_m + HALF_M

            try:
                win      = from_bounds(left, bottom, right, top, src.transform)
                data_raw = src.read(
                    1,
                    window=win,
                    out_shape=(NATIVE_PX, NATIVE_PX),
                    resampling=Resampling.bilinear,
                    boundless=True,
                    fill_value=0,
                )

                if nodata is not None:
                    data_raw = np.where(data_raw == nodata, 0, data_raw)

                data_raw = np.clip(data_raw, 0, 10_000).astype(np.float32)

                bu_1km  = round(_bu_score(data_raw, 1.0),  3)
                bu_5km  = round(_bu_score(data_raw, 5.0),  3)
                bu_20km = round(float(data_raw.mean()) / 100.0, 3)
                tile    = _render_tile(data_raw, cell)

            except Exception as exc:
                print(f'  WARN [{i}] {loc["id"]}: {exc}')
                tile    = _no_data_tile(cell)
                bu_1km  = 0.0
                bu_5km  = 0.0
                bu_20km = 0.0

            sprite.paste(tile, (col_idx * cell, row_idx * cell))

            loc[idx_key]  = i
            loc[key_1km]  = bu_1km
            loc[key_5km]  = bu_5km
            loc[key_20km] = bu_20km

            if (i + 1) % 1000 == 0 or i == n - 1:
                print(f'  {i + 1:>6}/{n}')

    print(f'\nSaving sprite → {sprite_out}')
    sprite_out.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(str(sprite_out), optimize=True)

    index[sprite_key] = {'cell': cell, 'cols': cols, 'rows': rows}

    # Recompute change metric whenever both years are present
    n_change = _compute_change(locations)
    if n_change:
        print(f'Computed bu_change for {n_change} stations (bu_2020_5km − bu_1975_5km)')

    print(f'Updating  → {INDEX_PATH}')
    write_sorted_json(INDEX_PATH, index)

    print('\nDone.')


if __name__ == '__main__':
    main()
