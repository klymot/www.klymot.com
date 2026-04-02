#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import tarfile
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import TextIO
import sys

if __package__ in (None, ''):
    sys.path.append(str(Path(__file__).resolve().parent))
    from json_utils import write_sorted_json
else:
    from .json_utils import write_sorted_json


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX_PATH = REPO_ROOT / 'docs' / 'data' / 'index.json'
DEFAULT_CACHE_DIR = REPO_ROOT / '.cache'
DEFAULT_QCF_DIR = REPO_ROOT / 'docs' / 'data' / 'qcf'
DEFAULT_QCU_DIR = REPO_ROOT / 'docs' / 'data' / 'qcu'

QCF_URL = 'https://www.ncei.noaa.gov/pub/data/ghcn/v4/ghcnm.tavg.latest.qcf.tar.gz'
QCU_URL = 'https://www.ncei.noaa.gov/pub/data/ghcn/v4/ghcnm.tavg.latest.qcu.tar.gz'

INVENTORY_ID = slice(0, 11)
INVENTORY_LAT = slice(12, 20)
INVENTORY_LNG = slice(21, 30)
INVENTORY_ELEV = slice(31, 37)
INVENTORY_NAME = slice(38, 68)

DATA_ID = slice(0, 11)
DATA_YEAR = slice(11, 15)
DATA_ELEMENT = slice(15, 19)
MONTH_FIELD_START = 19
MONTH_FIELD_WIDTH = 8
MONTH_VALUE = slice(0, 5)
MONTH_QCFLAG = slice(6, 7)
MISSING_VALUE = -9999


def count_valid_months(line: str) -> int:
    valid_months = 0
    for month_index in range(12):
        start = MONTH_FIELD_START + (month_index * MONTH_FIELD_WIDTH)
        chunk = line[start:start + MONTH_FIELD_WIDTH]
        value = int(chunk[MONTH_VALUE])
        qcflag = chunk[MONTH_QCFLAG]
        if value != MISSING_VALUE and not qcflag.strip():
            valid_months += 1
    return valid_months


def annual_mean_c(line: str) -> tuple[int, float] | None:
    total = 0
    count = 0

    for month_index in range(12):
        start = MONTH_FIELD_START + (month_index * MONTH_FIELD_WIDTH)
        chunk = line[start:start + MONTH_FIELD_WIDTH]
        value = int(chunk[MONTH_VALUE])
        qcflag = chunk[MONTH_QCFLAG]
        if value == MISSING_VALUE or qcflag.strip():
            continue
        total += value
        count += 1

    if count == 0:
        return None

    return count, (total / count) / 100.0


def conditional_download(url: str, cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    filename = url.rsplit('/', 1)[-1]
    archive_path = cache_dir / filename
    etag_path = cache_dir / f'{filename}.etag'

    headers: dict[str, str] = {}
    if archive_path.exists() and etag_path.exists():
        etag = etag_path.read_text().strip()
        if etag:
            headers['If-None-Match'] = etag

    request = urllib.request.Request(url, headers=headers)

    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and archive_path.exists():
            print(f'{filename}: cached archive is current (ETag match).')
            return archive_path
        raise

    with response:
        if getattr(response, 'status', None) == 304 and archive_path.exists():
            print(f'{filename}: cached archive is current (ETag match).')
            return archive_path

        print(f'{filename}: downloading archive...')
        with archive_path.open('wb') as handle:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                handle.write(chunk)

        etag = response.headers.get('ETag')
        if etag:
            etag_path.write_text(etag)

    return archive_path


def find_member_path(archive: tarfile.TarFile, suffix: str) -> str:
    for member in archive.getmembers():
        if member.isfile() and member.name.endswith(suffix):
            return member.name
    raise RuntimeError(f'Archive does not contain a {suffix} member')


def read_inventory(archive_path: Path) -> dict[str, dict[str, object]]:
    stations: dict[str, dict[str, object]] = {}

    with tarfile.open(archive_path, 'r:gz') as archive:
        inv_path = find_member_path(archive, '.inv')
        member = archive.extractfile(inv_path)
        if member is None:
            raise RuntimeError(f'Unable to open {inv_path} inside {archive_path.name}')

        for raw_line in member:
            line = raw_line.decode('utf-8').rstrip('\r\n')
            station_id = line[INVENTORY_ID].strip()
            if not station_id:
                continue

            stations[station_id] = {
                'id': station_id,
                'name': line[INVENTORY_NAME].rstrip(),
                'lat': float(line[INVENTORY_LAT]),
                'lng': float(line[INVENTORY_LNG]),
                'category': 'station',
                'elevation_m': parse_elevation(line[INVENTORY_ELEV]),
            }

    return stations


def parse_elevation(raw_value: str) -> float | None:
    value = float(raw_value)
    if value == -999.0:
        return None
    return value


def merge_inventory(index_path: Path, inventories: list[dict[str, dict[str, object]]]) -> list[str]:
    with index_path.open() as handle:
        index = json.load(handle)

    locations = index['locations']
    existing_by_id = {location.get('id'): location for location in locations if location.get('id')}

    added_station_ids: list[str] = []

    for inventory in inventories:
        for station_id, station in inventory.items():
            existing = existing_by_id.get(station_id)
            if existing is None:
                locations.append(dict(station))
                existing_by_id[station_id] = locations[-1]
                added_station_ids.append(station_id)
                continue

            for key, value in station.items():
                if key == 'category':
                    existing.setdefault('category', value)
                elif value is not None:
                    existing.setdefault(key, value)

    write_sorted_json(index_path, index)
    return [
        location['id']
        for location in locations
        if location.get('category') == 'station' and location.get('id')
    ]


def ensure_empty_station_files(station_ids: list[str], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for station_id in station_ids:
        (output_dir / f'{station_id}.csv').write_text('')


def write_station_csvs(
    archive_path: Path,
    output_dir: Path,
    station_ids: set[str],
) -> tuple[int, dict[str, dict[int, int]], dict[str, dict[int, float]]]:
    rows_written = 0
    current_station_id: str | None = None
    current_handle: TextIO | None = None
    coverage_by_station: dict[str, dict[int, int]] = defaultdict(dict)
    annual_means_by_station: dict[str, dict[int, float]] = defaultdict(dict)

    with tarfile.open(archive_path, 'r:gz') as archive:
        dat_path = find_member_path(archive, '.dat')
        member = archive.extractfile(dat_path)
        if member is None:
            raise RuntimeError(f'Unable to open {dat_path} inside {archive_path.name}')

        for raw_line in member:
            line = raw_line.decode('utf-8').rstrip('\r\n')
            if line[DATA_ELEMENT] != 'TAVG':
                continue
            valid_months = count_valid_months(line)
            if valid_months == 0:
                continue

            station_id = line[DATA_ID].strip()
            if station_id not in station_ids:
                continue

            year = int(line[DATA_YEAR])
            coverage_by_station[station_id][year] = valid_months
            annual_mean = annual_mean_c(line)
            if annual_mean is not None:
                month_count, mean_c = annual_mean
                if month_count >= 9:
                    annual_means_by_station[station_id][year] = mean_c

            if station_id != current_station_id:
                if current_handle is not None:
                    current_handle.close()
                current_station_id = station_id
                current_handle = (output_dir / f'{station_id}.csv').open('a', encoding='utf-8')

            current_handle.write(render_csv_row(line))
            rows_written += 1

    if current_handle is not None:
        current_handle.close()

    return rows_written, coverage_by_station, annual_means_by_station


def render_csv_row(line: str) -> str:
    cells = [line[DATA_YEAR]]

    for month_index in range(12):
        start = MONTH_FIELD_START + (month_index * MONTH_FIELD_WIDTH)
        chunk = line[start:start + MONTH_FIELD_WIDTH]
        value = int(chunk[MONTH_VALUE])
        qcflag = chunk[MONTH_QCFLAG]

        if value == MISSING_VALUE or qcflag.strip():
            cells.append('')
        else:
            cells.append(str(value))

    return ','.join(cells) + '\n'


def merge_station_coverage(
    coverage_sets: list[dict[str, dict[int, int]]]
) -> dict[str, dict[int, int]]:
    merged: dict[str, dict[int, int]] = defaultdict(dict)

    for coverage_by_station in coverage_sets:
        for station_id, years in coverage_by_station.items():
            station_years = merged[station_id]
            for year, valid_months in years.items():
                station_years[year] = max(station_years.get(year, 0), valid_months)

    return {station_id: dict(years) for station_id, years in merged.items()}


def longest_run_with_min_months(years: dict[int, int], *, min_months: int) -> int:
    longest = 0
    current = 0
    previous_year: int | None = None

    for year in sorted(years):
        if years[year] < min_months:
            current = 0
            previous_year = None
            continue

        if previous_year is not None and year == previous_year + 1:
            current += 1
        else:
            current = 1

        longest = max(longest, current)
        previous_year = year

    return longest


def linear_slope_per_100_years(years: dict[int, float]) -> float | None:
    if len(years) < 2:
        return None

    xs = sorted(years)
    ys = [years[year] for year in xs]

    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)

    sxx = sum((x - x_mean) ** 2 for x in xs)
    if sxx == 0:
        return None

    sxy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys, strict=True))
    return (sxy / sxx) * 100.0


def update_index_coverage(
    index_path: Path,
    coverage_by_station: dict[str, dict[int, int]],
    qcu_annual_means: dict[str, dict[int, float]],
    qcf_annual_means: dict[str, dict[int, float]],
) -> None:
    with index_path.open() as handle:
        index = json.load(handle)

    for location in index['locations']:
        station_id = location.get('id')
        if not station_id:
            continue

        years = coverage_by_station.get(station_id)
        if not years:
            location.pop('ghcn_first_year', None)
            location.pop('ghcn_last_year', None)
            location.pop('ghcn_longest_run_9_months', None)
        else:
            sorted_years = sorted(years)
            location['ghcn_first_year'] = sorted_years[0]
            location['ghcn_last_year'] = sorted_years[-1]
            location['ghcn_longest_run_9_months'] = longest_run_with_min_months(
                years,
                min_months=9,
            )

        qcu_slope = linear_slope_per_100_years(qcu_annual_means.get(station_id, {}))
        qcf_slope = linear_slope_per_100_years(qcf_annual_means.get(station_id, {}))
        if qcu_slope is None:
            location.pop('ghcn_qcu_slope_c_per_100yr', None)
        else:
            location['ghcn_qcu_slope_c_per_100yr'] = round(qcu_slope, 4)
        if qcf_slope is None:
            location.pop('ghcn_qcf_slope_c_per_100yr', None)
        else:
            location['ghcn_qcf_slope_c_per_100yr'] = round(qcf_slope, 4)

    write_sorted_json(index_path, index)


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Download latest GHCN-M v4 QCF/QCU archives and write per-station CSVs.'
    )
    parser.add_argument('--index', default=str(DEFAULT_INDEX_PATH), help='Path to docs/data/index.json')
    parser.add_argument('--cache-dir', default=str(DEFAULT_CACHE_DIR), help='Archive cache directory')
    parser.add_argument('--qcf-dir', default=str(DEFAULT_QCF_DIR), help='Output directory for QCF station CSVs')
    parser.add_argument('--qcu-dir', default=str(DEFAULT_QCU_DIR), help='Output directory for QCU station CSVs')
    parser.add_argument('--qcf-url', default=QCF_URL, help='QCF archive URL')
    parser.add_argument('--qcu-url', default=QCU_URL, help='QCU archive URL')
    args = parser.parse_args()

    index_path = Path(args.index)
    cache_dir = Path(args.cache_dir)
    qcf_dir = Path(args.qcf_dir)
    qcu_dir = Path(args.qcu_dir)

    qcf_archive = conditional_download(args.qcf_url, cache_dir)
    qcu_archive = conditional_download(args.qcu_url, cache_dir)

    print('Merging station inventories...')
    qcf_inventory = read_inventory(qcf_archive)
    qcu_inventory = read_inventory(qcu_archive)
    station_ids = merge_inventory(index_path, [qcf_inventory, qcu_inventory])
    station_id_set = set(station_ids)
    print(f'Stations in index: {len(station_ids)}')

    print(f'Initialising empty station files in {qcf_dir} and {qcu_dir}...')
    ensure_empty_station_files(station_ids, qcf_dir)
    ensure_empty_station_files(station_ids, qcu_dir)

    print(f'Writing QCF station CSVs from {qcf_archive.name}...')
    qcf_rows, qcf_coverage, qcf_annual_means = write_station_csvs(qcf_archive, qcf_dir, station_id_set)
    print(f'Wrote {qcf_rows} QCF rows.')

    print(f'Writing QCU station CSVs from {qcu_archive.name}...')
    qcu_rows, qcu_coverage, qcu_annual_means = write_station_csvs(qcu_archive, qcu_dir, station_id_set)
    print(f'Wrote {qcu_rows} QCU rows.')

    print(f'Updating coverage fields in {index_path}...')
    merged_coverage = merge_station_coverage([qcf_coverage, qcu_coverage])
    update_index_coverage(index_path, merged_coverage, qcu_annual_means, qcf_annual_means)


if __name__ == '__main__':
    main()
