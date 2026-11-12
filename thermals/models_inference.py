"""
Multi-Model Inference Engine for Thermatics.
Loads trained LightGBM and XGBoost models, processes 42 curated features,
and outputs calibrated thermal probability and risk tiers (Low, Medium, High).
"""

import json
import logging
import numpy as np
import pandas as pd
import lightgbm as lgb
import xgboost as xgb

try:
    from .config import (
        LGBM_WEIGHTS,
        XGB_WEIGHTS,
        SCALER_STATS,
        CURATED_CORE_FEATURES,
        LOW_THRESHOLD,
        HIGH_THRESHOLD,
        COLOR_LOW,
        COLOR_MED,
        COLOR_HIGH,
    )
except ImportError:
    from config import (
        LGBM_WEIGHTS,
        XGB_WEIGHTS,
        SCALER_STATS,
        CURATED_CORE_FEATURES,
        LOW_THRESHOLD,
        HIGH_THRESHOLD,
        COLOR_LOW,
        COLOR_MED,
        COLOR_HIGH,
    )


class ThermalPredictor:
    """
    Manages model loading and prediction for LightGBM, XGBoost, and Ensemble.
    """

    def __init__(self):
        self.lgbm_model = None
        self.xgb_model = None
        self.feature_medians = {}
        self._load_reference_medians()
        self._load_models()

    def _load_reference_medians(self):
        if SCALER_STATS.exists():
            with open(SCALER_STATS, "r") as f:
                data = json.load(f)
                self.feature_medians = data.get("centers", {})
                logging.info(f"Loaded {len(self.feature_medians)} reference medians from {SCALER_STATS.name}")

    def _load_models(self):
        if not LGBM_WEIGHTS.exists():
            raise FileNotFoundError(f"LightGBM weights not found at {LGBM_WEIGHTS}")
        self.lgbm_model = lgb.Booster(model_file=str(LGBM_WEIGHTS))
        logging.info(f"Loaded LightGBM model from {LGBM_WEIGHTS.name} ({self.lgbm_model.num_trees()} trees)")

        if not XGB_WEIGHTS.exists():
            raise FileNotFoundError(f"XGBoost weights not found at {XGB_WEIGHTS}")
        self.xgb_model = xgb.Booster()
        self.xgb_model.load_model(str(XGB_WEIGHTS))
        logging.info(f"Loaded XGBoost model from {XGB_WEIGHTS.name}")

    def format_classification(self, prob: float, low_thresh: float = LOW_THRESHOLD, high_thresh: float = HIGH_THRESHOLD):
        prob_val = float(prob)
        if prob_val < low_thresh:
            return {"level": "low", "label": "Low Thermal Chance", "color": COLOR_LOW, "badge": "Low"}
        if prob_val < high_thresh:
            return {"level": "medium", "label": "Medium Thermal Chance", "color": COLOR_MED, "badge": "Medium"}
        return {"level": "high", "label": "High Thermal Chance", "color": COLOR_HIGH, "badge": "High"}

    def predict_dataframe(
        self,
        df_features: pd.DataFrame,
        low_thresh: float = LOW_THRESHOLD,
        high_thresh: float = HIGH_THRESHOLD,
    ) -> list:
        X = pd.DataFrame(index=df_features.index)
        for feat in CURATED_CORE_FEATURES:
            if feat in df_features.columns:
                X[feat] = pd.to_numeric(df_features[feat], errors="coerce")
            else:
                X[feat] = self.feature_medians.get(feat, 0.0)

            if X[feat].isna().any():
                X[feat] = X[feat].fillna(self.feature_medians.get(feat, 0.0))

        n_samples = len(X)
        lgbm_probs = self.lgbm_model.predict(X.values)
        dmat = xgb.DMatrix(X.values)
        xgb_probs = self.xgb_model.predict(dmat)
        ens_probs = 0.5 * lgbm_probs + 0.5 * xgb_probs

        results = []
        for i in range(n_samples):
            p_lgb = float(np.clip(lgbm_probs[i], 0.0, 1.0))
            p_xgb = float(np.clip(xgb_probs[i], 0.0, 1.0))
            p_ens = float(np.clip(ens_probs[i], 0.0, 1.0))

            c_lgb = self.format_classification(p_lgb, low_thresh, high_thresh)
            c_xgb = self.format_classification(p_xgb, low_thresh, high_thresh)
            c_ens = self.format_classification(p_ens, low_thresh, high_thresh)

            results.append({
                "lightgbm": {"probability": round(p_lgb, 4), "percentage": round(p_lgb * 100.0, 1), **c_lgb},
                "xgboost": {"probability": round(p_xgb, 4), "percentage": round(p_xgb * 100.0, 1), **c_xgb},
                "ensemble": {"probability": round(p_ens, 4), "percentage": round(p_ens * 100.0, 1), **c_ens},
            })

        return results

