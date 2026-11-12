"""
Terrain grid loader for Boise domain (690 cells).
Loads precomputed topography from boise_terrain_grid.json without requiring rasterio in CI.
"""

import json
import logging

try:
    from .config import TERRAIN_CACHE_FILE, DATA_DIR
except ImportError:
    from config import TERRAIN_CACHE_FILE, DATA_DIR


def generate_terrain_grid(force_recompute: bool = False):
    """
    Loads the precomputed 690-cell Boise terrain grid from boise_terrain_grid.json.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not force_recompute and TERRAIN_CACHE_FILE.exists():
        with open(TERRAIN_CACHE_FILE, "r") as f:
            cached = json.load(f)
        logging.info(f"Loaded {len(cached)} cached terrain cells from {TERRAIN_CACHE_FILE}")
        return cached

    raise FileNotFoundError(
        f"Precomputed terrain grid not found at {TERRAIN_CACHE_FILE}. "
        "Ensure thermals/data/boise_terrain_grid.json is committed."
    )

