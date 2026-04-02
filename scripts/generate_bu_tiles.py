#!/usr/bin/env python3
"""
Generate built-up (BU) sprite tiles for all stations in docs/data/index.json.

For each station a 20×20 km thumbnail is extracted from the GHSL 2020 built-up
surface raster, coloured with orwell2024/builtmap's 8-stop palette, and stitched
into a single PNG sprite sheet.  The script also computes bu_5km and bu_20km
percentage scores and writes them back into index.json alongside a bu_idx field
(the sprite grid index) and a root-level bu_sprite descriptor.

GHSL data
---------
By default the script downloads GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0.zip
(~3 GB) from the JRC FTP mirror and caches it under .cache/.  An ETag file is
stored alongside the zip so subsequent runs only re-download if the remote file
has changed.  Supply --ghsl to point at an already-extracted .tif and skip the
download entirely.

For faster random access, convert the extracted tif to a Cloud Optimised GeoTIFF:
  gdal_translate -of COG -co COMPRESS=LZW \\
      .cache/GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0.tif \\
      .cache/GHS_BUILT_S_cog.tif

Usage
-----
  python3 scripts/generate_bu_tiles.py               # auto-download & cache
  python3 scripts/generate_bu_tiles.py --ghsl .cache/GHS_BUILT_S_cog.tif
  GHSL_TIF=/data/GHS_BUILT_S.tif python3 scripts/generate_bu_tiles.py
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

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT  = Path(__file__).resolve().parent.parent
INDEX_PATH = REPO_ROOT / 'docs' / 'data' / 'index.json'
SPRITE_OUT = REPO_ROOT / 'docs' / 'assets' / 'bu-sprite.png'
CACHE_DIR  = REPO_ROOT / '.cache'

# GHSL 2020 built-up surface, 100 m Mollweide, R2023A release
_GHSL_BASENAME = 'GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100_V1_0'
GHSL_TIF_NAME  = _GHSL_BASENAME + '.tif'
GHSL_ZIP_NAME  = _GHSL_BASENAME + '.zip'
GHSL_DEFAULT   = CACHE_DIR / GHSL_TIF_NAME
GHSL_ZIP_CACHE = CACHE_DIR / GHSL_ZIP_NAME
GHSL_ETAG_FILE = CACHE_DIR / (GHSL_ZIP_NAME + '.etag')

GHSL_URL = (
    'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/'
    'GHS_BUILT_S_GLOBE_R2023A/'
    f'GHS_BUILT_S_E2020_GLOBE_R2023A_54009_100/V1-0/{GHSL_ZIP_NAME}'
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

def _ensure_ghsl() -> Path:
    """
    Ensure the GHSL tif is present in .cache/, downloading and extracting if
    needed.  Uses an ETag file to skip the download when the remote is unchanged.
    Returns the path to the .tif file.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if GHSL_DEFAULT.exists():
        # Check whether the remote zip has changed via ETag.
        stored_etag = GHSL_ETAG_FILE.read_text().strip() if GHSL_ETAG_FILE.exists() else ''
        headers = {'If-None-Match': stored_etag} if stored_etag else {}
        req = urllib.request.Request(GHSL_URL, headers=headers)
        try:
            resp = urllib.request.urlopen(req)
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                print(f'GHSL: cached file is current (ETag match).')
                return GHSL_DEFAULT
            raise

        if resp.status == 304:
            print('GHSL: cached file is current (ETag match).')
            resp.close()
            return GHSL_DEFAULT

        # Remote has changed — fall through to (re-)download.
        print('GHSL: remote has changed, re-downloading...')
        _download_and_extract(resp)
    else:
        print(f'GHSL: not found in cache, downloading (~3 GB)...')
        print(f'      {GHSL_URL}')
        req = urllib.request.Request(GHSL_URL)
        resp = urllib.request.urlopen(req)
        _download_and_extract(resp)

    return GHSL_DEFAULT


def _download_and_extract(resp) -> None:
    """Stream *resp* to GHSL_ZIP_CACHE, save its ETag, then extract the tif."""
    etag        = resp.headers.get('ETag', '')
    total_bytes = int(resp.headers.get('Content-Length', 0))
    downloaded  = 0

    with open(GHSL_ZIP_CACHE, 'wb') as fh:
        while True:
            chunk = resp.read(1 << 20)  # 1 MB chunks
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
        GHSL_ETAG_FILE.write_text(etag)

    print('Extracting tif from zip...')
    with zipfile.ZipFile(GHSL_ZIP_CACHE) as zf:
        tif_members = [m for m in zf.namelist() if m.endswith('.tif')]
        if not tif_members:
            raise RuntimeError(f'No .tif found inside {GHSL_ZIP_CACHE}')
        member = tif_members[0]
        print(f'  {member}  →  {GHSL_DEFAULT}')
        with zf.open(member) as src, open(GHSL_DEFAULT, 'wb') as dst:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                dst.write(chunk)

    print('Extraction complete.')

# ── LUT build (vectorised colour mapping) ─────────────────────────────────────

def _palette_color(pct: float) -> tuple:
    """Map built-up % [0..100] to (R, G, B) via piecewise-linear palette."""
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
    """Build a 10 001-entry LUT: raw GHSL value (0..10 000) → RGB uint8."""
    lut = np.zeros((10_001, 3), dtype=np.uint8)
    for v in range(10_001):
        lut[v] = _palette_color(v / 100.0)
    return lut


_LUT: np.ndarray | None = None

# ── Tile rendering ─────────────────────────────────────────────────────────────

def _render_tile(data_raw: np.ndarray, cell: int) -> Image.Image:
    """
    Convert a 2-D array of raw GHSL values (0..10 000, m² built-up per pixel)
    into a cell×cell RGB image with a white crosshair at the centre.
    """
    global _LUT
    if _LUT is None:
        _LUT = _build_lut()

    idx = np.clip(data_raw.astype(np.int32), 0, 10_000)
    rgb = _LUT[idx].copy()  # (H, W, 3) uint8

    # White crosshair
    h, w = rgb.shape[:2]
    cx, cy = w // 2, h // 2
    arm = max(3, h // 25)
    rgb[cy, max(0, cx - arm): cx + arm + 1] = (255, 255, 255)
    rgb[max(0, cy - arm): cy + arm + 1, cx] = (255, 255, 255)
    rgb[max(0, cy - 1): cy + 2, max(0, cx - 1): cx + 2] = (255, 255, 255)

    img = Image.fromarray(rgb, 'RGB')
    if cell != NATIVE_PX:
        img = img.resize((cell, cell), Image.LANCZOS)
    return img


def _no_data_tile(cell: int) -> Image.Image:
    """Dark-grey placeholder for stations with no GHSL coverage."""
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
    # raw value is m² per 100 m² pixel; /100 → %
    return float(vals.mean() / 100.0) if vals.size > 0 else 0.0

# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Generate BU sprite tiles from GHSL 2020 built-up surface data.'
    )
    parser.add_argument(
        '--ghsl',
        default=os.environ.get('GHSL_TIF'),
        metavar='PATH',
        help=(
            'Path to GHS_BUILT_S_E2020 .tif (or set GHSL_TIF env var). '
            'Omit to auto-download into .cache/.'
        ),
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

    # Resolve GHSL path — auto-download into .cache/ if not supplied.
    if args.ghsl:
        ghsl_path = Path(args.ghsl)
        if not ghsl_path.exists():
            print(f'ERROR: GHSL file not found: {ghsl_path}', file=sys.stderr)
            sys.exit(1)
    else:
        ghsl_path = _ensure_ghsl()

    cell = args.cell
    cols = args.cols

    with open(INDEX_PATH) as fh:
        index = json.load(fh)

    locations = index['locations']
    n    = len(locations)
    rows = math.ceil(n / cols)

    sprite_w = cols * cell
    sprite_h = rows * cell
    print(f'Stations : {n}')
    print(f'Grid     : {cols} cols × {rows} rows  ({sprite_w} × {sprite_h} px)')
    print(f'Cell     : {cell} px')
    print(f'GHSL     : {ghsl_path}')
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

                bu_5km  = round(_bu_score(data_raw, 5.0),  3)
                bu_20km = round(float(data_raw.mean()) / 100.0, 3)
                tile    = _render_tile(data_raw, cell)

            except Exception as exc:
                print(f'  WARN [{i}] {loc["id"]}: {exc}')
                tile    = _no_data_tile(cell)
                bu_5km  = 0.0
                bu_20km = 0.0

            sprite.paste(tile, (col_idx * cell, row_idx * cell))

            loc['bu_idx']  = i
            loc['bu_5km']  = bu_5km
            loc['bu_20km'] = bu_20km

            if (i + 1) % 1000 == 0 or i == n - 1:
                print(f'  {i + 1:>6}/{n}')

    print(f'\nSaving sprite → {SPRITE_OUT}')
    SPRITE_OUT.parent.mkdir(parents=True, exist_ok=True)
    sprite.save(str(SPRITE_OUT), optimize=True)

    index['bu_sprite'] = {'cell': cell, 'cols': cols, 'rows': rows}

    print(f'Updating  → {INDEX_PATH}')
    with open(INDEX_PATH, 'w') as fh:
        json.dump(index, fh, indent=2)

    print('\nDone.')


if __name__ == '__main__':
    main()
