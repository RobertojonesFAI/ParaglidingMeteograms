"""
Configuration settings for Thermal Prediction Engine (Boise Domain).
Self-contained inside ParaglidingMeteograms/thermals for local and CI execution.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
MODELS_DIR = BASE_DIR / "models"
DATA_DIR = BASE_DIR / "data"

# Optional local DEM files (only used if force_recompute=True; normal runs use boise_terrain_grid.json)
BOISE_DEM_PATH = REPO_ROOT.parent / "dems" / "boise" / "Boise_merged_full.tif"
BOISE_ALBEDO_PATH = REPO_ROOT.parent / "dems" / "boise" / "albedo_boise.tif"

# Model artifacts
LGBM_WEIGHTS = MODELS_DIR / "best_lightgbm.txt"
XGB_WEIGHTS = MODELS_DIR / "best_xgboost.json"
SCALER_STATS = MODELS_DIR / "scaler_stats.json"

# Precomputed 690-cell topography grid and local forecast cache
TERRAIN_CACHE_FILE = DATA_DIR / "boise_terrain_grid.json"
FORECAST_CACHE_FILE = DATA_DIR / "forecast_predictions.json"

# Local dev-data output (gitignored; production serves from R2 at /data/thermal_predictions.json)
METEOGRAMS_WEB_DIR = REPO_ROOT / "web"
METEOGRAMS_DEV_DATA_DIR = METEOGRAMS_WEB_DIR / "dev-data"
METEOGRAMS_DEV_FORECAST_FILE = METEOGRAMS_DEV_DATA_DIR / "thermal_predictions.json"

# R2 bucket object key
R2_FORECAST_KEY = "thermal_predictions.json"

# Spatial domain: Boise, Idaho and surrounding foothills / Bogus Basin / Lucky Peak
MIN_LAT = 43.48
MAX_LAT = 43.82
MIN_LON = -116.34
MAX_LON = -115.90
GRID_RESOLUTION_DEG = 0.015  # ~1.6 km resolution (690 cells)

# Center reference coordinate for Boise
BOISE_CENTER_LAT = 43.6150
BOISE_CENTER_LON = -116.2023
BOISE_TIMEZONE = "America/Boise"

# Daytime soaring window (8:00 AM to 8:00 PM local time, 13 hours)
DAYTIME_HOURS_LOCAL = list(range(8, 21))
FORECAST_HORIZON_HOURS = 13

# Classification thresholds
LOW_THRESHOLD = 0.35
HIGH_THRESHOLD = 0.50

COLOR_LOW = "#ef4444"    # Red
COLOR_MED = "#eab308"    # Yellow
COLOR_HIGH = "#22c55e"   # Green

MODELS = ["ensemble", "lightgbm", "xgboost"]

# Exact 42 feature names and sequence used by LightGBM & XGBoost
CURATED_CORE_FEATURES = [
    "TOL_8000", "TOL_1000", "u_wind_6500", "u_wind_2000", "v_wind_7000", "v_wind_2000",
    "temperature_8000", "temperature_2500", "pressure_10000", "pressure_2500",
    "env_lapse_rate_4000", "env_lapse_rate_11000", "instability_1000", "instability_11000",
    "dew_height_4000", "inversion_layer_1000", "absorbed_radiation", "blh_sfc",
    "cape_sfc", "cin_sfc", "d2m_subh", "diffuse_fraction", "effective_headwind",
    "elev_x_instability", "elevation_delta", "fricv_sfc", "fsr_sfc", "full_net_radiation",
    "gust_subh", "hour_of_day", "hours_past_solar_noon", "ishf_sfc", "lftx_sfc",
    "max_elevation", "mean_aspect", "mean_slope", "month", "neighbor_max_elevation",
    "orog_subh", "slope_x_solar", "solar_x_south_facing", "south_facing_fraction",
]

