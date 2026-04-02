from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def sort_json_maps(value: Any) -> Any:
    """Recursively sort dictionary keys while preserving list order."""
    if isinstance(value, dict):
        return {key: sort_json_maps(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [sort_json_maps(item) for item in value]
    return value


def write_sorted_json(path: Path, value: Any) -> None:
    """Write pretty-printed JSON with stable key ordering."""
    path.write_text(json.dumps(sort_json_maps(value), indent=2) + '\n')
