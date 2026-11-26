import json

import numpy as np
import pandas as pd
import pytest

from thermals.config import SCALER_STATS
from thermals.models_inference import ThermalPredictor

MEDIANS = json.loads(SCALER_STATS.read_text())["centers"]


@pytest.fixture(scope="module")
def predictor():
    return ThermalPredictor()


def test_models_give_the_recorded_probability_at_the_training_medians(predictor):
    # Guards the model files and the input order: any change to either moves these.
    lgbm, xgbm = predictor.predict(pd.DataFrame([MEDIANS]))
    assert lgbm[0] == pytest.approx(0.40525, abs=1e-4)
    assert xgbm[0] == pytest.approx(0.37617, abs=1e-4)


def test_a_missing_input_is_an_error_not_a_guess(predictor):
    row = {k: v for k, v in MEDIANS.items() if k != "cape_sfc"}
    with pytest.raises(ValueError, match="cape_sfc"):
        predictor.predict(pd.DataFrame([row]))


def test_a_non_finite_input_is_an_error(predictor):
    with pytest.raises(ValueError, match="blh_sfc"):
        predictor.predict(pd.DataFrame([{**MEDIANS, "blh_sfc": np.nan}]))


def test_the_training_season_is_march_to_september(predictor):
    assert [m for m in range(1, 13) if predictor.season_supported(m)] == list(range(3, 10))


def test_inputs_outside_training_are_reported(predictor):
    rows = pd.DataFrame([MEDIANS] * 10)
    assert predictor.inputs_outside_training(rows) == []
    rows.loc[:4, "lftx_sfc"] = 15.0  # half the cells, above the training maximum
    assert predictor.inputs_outside_training(rows) == ["lftx_sfc"]
