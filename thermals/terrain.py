"""
Loads the 690-cell Boise terrain grid (thermals/data/boise_terrain_grid.json).
"""

import json

from .config import TERRAIN_CACHE_FILE


def load_terrain_grid(path=TERRAIN_CACHE_FILE) -> list[dict]:
    """Each cell's id, centre, elevation, slope, aspect, albedo and zone name."""
    with open(path) as f:
        return json.load(f)
