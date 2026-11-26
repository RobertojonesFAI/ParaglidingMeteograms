"""
Settings for the Boise thermal prediction pipeline.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
MODELS_DIR = BASE_DIR / "models"
DATA_DIR = BASE_DIR / "data"

# Trained models. The scaler's medians are not used for prediction (tree models
# need no scaling); tests use them to check the input formulas against training.
LGBM_WEIGHTS = MODELS_DIR / "best_lightgbm.txt"
XGB_WEIGHTS = MODELS_DIR / "best_xgboost.json"
SCALER_STATS = MODELS_DIR / "scaler_stats.json"

# The 690-cell terrain grid (0.015° ≈ 1.6 km) the map shows. The website reads
# the same file to decide which launches are inside the map.
TERRAIN_CACHE_FILE = DATA_DIR / "boise_terrain_grid.json"
FORECAST_CACHE_FILE = DATA_DIR / "forecast_predictions.json"
GRID_RESOLUTION_DEG = 0.015

# Local copy for `pnpm dev` (web/dev-data is gitignored); production serves the
# R2 object at /data/thermal_predictions.json.
METEOGRAMS_WEB_DIR = REPO_ROOT / "web"
METEOGRAMS_DEV_DATA_DIR = METEOGRAMS_WEB_DIR / "dev-data"
METEOGRAMS_DEV_FORECAST_FILE = METEOGRAMS_DEV_DATA_DIR / "thermal_predictions.json"

R2_FORECAST_KEY = "thermal_predictions.json"

# Solar geometry is computed at the domain's centre.
BOISE_CENTER_LAT = 43.6150
BOISE_CENTER_LON = -116.2023
BOISE_TIMEZONE = "America/Boise"

# The forecast hours shown each day (local time), 8 AM to 8 PM.
DAYTIME_HOURS_LOCAL = list(range(8, 21))

# The models were trained on March to September. Outside those months the
# forecast is still published, with each day marked out of season so the page
# warns that it is less reliable. False publishes no hours in those months.
FORECAST_OUT_OF_SEASON = True

# Default probability cutoffs for the map's colours; visitors can change them.
LOW_THRESHOLD = 0.35
HIGH_THRESHOLD = 0.50

# The 42 model inputs, in the order the models take them.
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
