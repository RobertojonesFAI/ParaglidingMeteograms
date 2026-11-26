"""The input formulas against the training data the models recorded.

The training script is not in the repository, but the models record the range
of every input and scaler_stats.json its median. Inputs that the formulas
derive from one another must keep the same relation in those statistics."""

import json

import numpy as np
import pytest

from thermals.config import CURATED_CORE_FEATURES, SCALER_STATS
from thermals.features import DRY_ADIABATIC_C_PER_KM, SOUNDING_BASE_M, sounding_features, wind_terrain_features
from thermals.models_inference import training_ranges

RANGES = training_ranges()
MEDIANS = json.loads(SCALER_STATS.read_text())["centers"]


def test_scaler_and_model_list_the_same_inputs_in_order():
    assert list(MEDIANS) == CURATED_CORE_FEATURES
    assert list(RANGES) == CURATED_CORE_FEATURES


def test_dew_height_is_the_4000_m_dew_gradient_with_the_379_m_base():
    # dew_height_4000 = env_lapse_rate_4000 * (4000 - 379) / 9.8, for the median and both ends of the range.
    factor = (4000.0 - SOUNDING_BASE_M) / DRY_ADIABATIC_C_PER_KM
    assert MEDIANS["dew_height_4000"] == pytest.approx(MEDIANS["env_lapse_rate_4000"] * factor, rel=1e-4)
    for end in (0, 1):
        assert RANGES["dew_height_4000"][end] == pytest.approx(RANGES["env_lapse_rate_4000"][end] * factor, rel=1e-4)


def test_instability_is_the_dew_gradient_minus_the_dry_adiabatic_rate():
    assert MEDIANS["instability_11000"] == pytest.approx(MEDIANS["env_lapse_rate_11000"] - DRY_ADIABATIC_C_PER_KM, abs=1e-3)
    for end in (0, 1):
        assert RANGES["instability_11000"][end] == pytest.approx(
            RANGES["env_lapse_rate_11000"][end] - DRY_ADIABATIC_C_PER_KM, abs=1e-3
        )


def test_heights_are_metres_and_pressures_hectopascals():
    # 2.5 km and 10 km in a standard atmosphere are about 750 hPa and 265 hPa.
    assert 700 < MEDIANS["pressure_2500"] < 800
    assert 230 < MEDIANS["pressure_10000"] < 300
    assert -45 < MEDIANS["temperature_8000"] < -15


def test_sensible_heat_flux_is_positive_upward_as_in_hrrr():
    # Daytime heating is positive in training (ERA5's convention would make it negative).
    assert MEDIANS["ishf_sfc"] > 100
    assert RANGES["ishf_sfc"][1] > 500


def test_sounding_features_on_a_known_profile():
    one = lambda v: np.array([v], dtype=float)
    out = sounding_features(
        low_temp_c=one(25.0),
        low_dew_c=one(5.0),
        temp_c={1000: one(20.0), 8000: one(-30.0)},
        dew_c={1000: one(2.0), 4000: one(-15.0), 11000: one(-60.0)},
    )
    assert out["TOL_8000"][0] == pytest.approx(55.0 * 125.0)
    assert out["TOL_1000"][0] == pytest.approx(5.0 * 125.0)
    assert out["env_lapse_rate_4000"][0] == pytest.approx(-20.0 * 1000.0 / 3621.0)
    assert out["instability_11000"][0] == pytest.approx(-65.0 * 1000.0 / 10621.0 - 9.8)
    assert out["dew_height_4000"][0] == pytest.approx(-20.0 * 1000.0 / 9.8)
    assert out["inversion_layer_1000"][0] == pytest.approx(-5.0 / 25.0)


def test_headwind_is_positive_when_the_wind_blows_from_the_face():
    out = wind_terrain_features(
        aspect_deg=np.array([180.0, 180.0]),
        wind_dir_deg=np.array([180.0, 0.0]),
        wind_speed_ms=np.array([4.0, 4.0]),
        elevation_delta_m=np.array([100.0, 100.0]),
        instability_1000=np.array([-10.0, -10.0]),
    )
    assert out["effective_headwind"] == pytest.approx([4.0, -4.0])
    assert out["elev_x_instability"] == pytest.approx([-1000.0, -1000.0])
