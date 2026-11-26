"""
The derived model inputs, kept as pure functions so they can be tested.

The training script (data_preparation_pipeline_multiregion.py) is not in this
repository, so these formulas cannot be compared with it line by line. What can
be checked is the training data itself: the models record the range of every
input (best_lightgbm.txt, feature_infos) and scaler_stats.json records its
median. tests/test_features.py checks that the training ranges and medians obey
the same relations as the formulas below, for example

    dew_height_4000      = env_lapse_rate_4000 * (4000 - 379) / 9.8
    instability_11000    = env_lapse_rate_11000 - 9.8

which only holds if training computed "lapse rates" from dew points with the
same 379 m base, as here. The names are historical: these are dew-point
gradients, not temperature lapse rates.
"""

import numpy as np

# The fixed base height (m) in the training formulas.
SOUNDING_BASE_M = 379.0
# Dry adiabatic lapse rate (°C per km) used by the training formulas.
DRY_ADIABATIC_C_PER_KM = 9.8


def sounding_features(
    low_temp_c: np.ndarray,
    low_dew_c: np.ndarray,
    temp_c: dict[int, np.ndarray],
    dew_c: dict[int, np.ndarray],
) -> dict[str, np.ndarray]:
    """Skew-T style inputs from the 2 m temperature and dew point and the
    profile interpolated to fixed heights (metres above sea level)."""

    def dew_gradient(height_m: int) -> np.ndarray:
        return (dew_c[height_m] - low_dew_c) * 1000.0 / (height_m - SOUNDING_BASE_M)

    env_1000 = dew_gradient(1000)
    env_4000 = dew_gradient(4000)
    env_11000 = dew_gradient(11000)
    return {
        # "Top of lift": °C difference scaled by 1000/8.
        "TOL_8000": (low_temp_c - temp_c[8000]) * 1000.0 / 8.0,
        "TOL_1000": (low_temp_c - temp_c[1000]) * 1000.0 / 8.0,
        "env_lapse_rate_1000": env_1000,
        "env_lapse_rate_4000": env_4000,
        "env_lapse_rate_11000": env_11000,
        "instability_1000": env_1000 - DRY_ADIABATIC_C_PER_KM,
        "instability_11000": env_11000 - DRY_ADIABATIC_C_PER_KM,
        "dew_height_4000": (dew_c[4000] - low_dew_c) * 1000.0 / DRY_ADIABATIC_C_PER_KM,
        "inversion_layer_1000": (temp_c[1000] - low_temp_c)
        / np.maximum(np.maximum(temp_c[1000], low_temp_c), 1.0),
    }


def wind_terrain_features(
    aspect_deg: np.ndarray,
    wind_dir_deg: np.ndarray,
    wind_speed_ms: np.ndarray,
    elevation_delta_m: np.ndarray,
    instability_1000: np.ndarray,
) -> dict[str, np.ndarray]:
    """Inputs that combine a cell's terrain with the wind and the sounding."""
    return {
        "effective_headwind": np.cos(np.radians(aspect_deg - wind_dir_deg)) * wind_speed_ms,
        "elev_x_instability": elevation_delta_m * instability_1000,
    }
