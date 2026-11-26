"""
Runs the trained LightGBM and XGBoost models on the 42 inputs.

The models were trained on data covering a limited range of each input; the
LightGBM model file records that range for every input (`feature_infos`).
Tree models do not extrapolate: an input beyond its training range is treated
as if it were at the edge of the range. So inputs outside the range are reported
with each hour, and the months the models never saw are not forecast at all
(see `season_supported`).
"""

import logging
import re

import numpy as np
import pandas as pd
import lightgbm as lgb
import xgboost as xgb

from .config import LGBM_WEIGHTS, XGB_WEIGHTS, CURATED_CORE_FEATURES

# An hour lists an input as outside the training range when more than this
# share of the cells have it outside.
OUT_OF_RANGE_REPORT_SHARE = 0.2


def training_ranges(model_file=LGBM_WEIGHTS) -> dict[str, tuple[float, float]]:
    """The [min, max] of every input in the training data, from the LightGBM model file."""
    text = model_file.read_text()
    match = re.search(r"^feature_infos=(.*)$", text, re.M)
    if not match:
        raise ValueError(f"{model_file.name} has no feature_infos line")
    infos = match.group(1).split()
    if len(infos) != len(CURATED_CORE_FEATURES):
        raise ValueError(f"{model_file.name} has {len(infos)} inputs; config lists {len(CURATED_CORE_FEATURES)}")
    ranges = {}
    for name, info in zip(CURATED_CORE_FEATURES, infos):
        low, high = info.strip("[]").split(":")
        ranges[name] = (float(low), float(high))
    return ranges


class ThermalPredictor:
    def __init__(self):
        self.ranges = training_ranges()
        self.lgbm_model = lgb.Booster(model_file=str(LGBM_WEIGHTS))
        self.xgb_model = xgb.Booster()
        self.xgb_model.load_model(str(XGB_WEIGHTS))
        for name, count in (("LightGBM", self.lgbm_model.num_feature()), ("XGBoost", self.xgb_model.num_features())):
            if count != len(CURATED_CORE_FEATURES):
                raise ValueError(f"{name} model takes {count} inputs; config lists {len(CURATED_CORE_FEATURES)}")
        logging.info(f"Loaded LightGBM ({self.lgbm_model.num_trees()} trees) and XGBoost models")

    def season_supported(self, month: int) -> bool:
        """Whether the models saw this month in training."""
        low, high = self.ranges["month"]
        return low <= month <= high

    def inputs_outside_training(self, features: pd.DataFrame) -> list[str]:
        """The inputs that more than OUT_OF_RANGE_REPORT_SHARE of the cells have outside the training range."""
        out = []
        for name in CURATED_CORE_FEATURES:
            low, high = self.ranges[name]
            values = features[name].to_numpy(dtype=float)
            if np.mean((values < low) | (values > high)) > OUT_OF_RANGE_REPORT_SHARE:
                out.append(name)
        return out

    def predict(self, features: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        """LightGBM and XGBoost probabilities, one per row. Every input must be
        present and finite: a guessed value would give a plausible but wrong map."""
        missing = [name for name in CURATED_CORE_FEATURES if name not in features.columns]
        if missing:
            raise ValueError(f"missing model inputs: {', '.join(missing)}")
        X = features[CURATED_CORE_FEATURES].to_numpy(dtype=float)
        bad = [name for name, ok in zip(CURATED_CORE_FEATURES, np.isfinite(X).all(axis=0)) if not ok]
        if bad:
            raise ValueError(f"non-finite model inputs: {', '.join(bad)}")
        lgbm = np.clip(self.lgbm_model.predict(X), 0.0, 1.0)
        xgbm = np.clip(self.xgb_model.predict(xgb.DMatrix(X)), 0.0, 1.0)
        return lgbm, xgbm
