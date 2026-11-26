"""The hourly pipeline end to end, with a fake HRRR and no R2."""

import json
from datetime import datetime, timezone

import numpy as np
import pytest

from thermals.config import DAYTIME_HOURS_LOCAL, SCALER_STATS
from thermals.models_inference import ThermalPredictor
from thermals.pipeline import SCHEMA, run_pipeline

MEDIANS = json.loads(SCALER_STATS.read_text())["centers"]
MET_INPUTS = [
    "TOL_8000", "TOL_1000", "env_lapse_rate_4000", "env_lapse_rate_11000", "instability_1000",
    "instability_11000", "dew_height_4000", "inversion_layer_1000", "u_wind_6500", "u_wind_2000",
    "v_wind_7000", "v_wind_2000", "temperature_8000", "temperature_2500", "pressure_10000",
    "pressure_2500", "blh_sfc", "cape_sfc", "cin_sfc", "d2m_subh", "diffuse_fraction", "fricv_sfc",
    "fsr_sfc", "full_net_radiation", "gust_subh", "ishf_sfc", "lftx_sfc", "orog_subh",
]


class FakeFetcher:
    """Training-median weather everywhere; records which hours were fetched."""

    fetched: list[str] = []
    cleaned = False

    def __init__(self, terrain_cells, run_time_utc):
        self.n = len(terrain_cells)
        self.run = run_time_utc

    def fetch_hour(self, valid_local):
        FakeFetcher.fetched.append(valid_local.strftime("%Y-%m-%d %H"))
        met = {name: np.full(self.n, MEDIANS[name]) for name in MET_INPUTS}
        met["wind_speed_ms"] = np.full(self.n, 3.0)
        met["wind_dir_deg"] = np.full(self.n, 270.0)
        summary = {
            "cycle_utc": self.run.isoformat(), "fxx": 1, "t2m_c": 25.0, "d2m_c": 3.0, "wind_speed_mph": 6.7,
            "wind_dir_deg": 270.0, "cape_sfc": 20.0, "blh_sfc": 1800.0, "ishf_sfc": 280.0, "full_net_radiation": 550.0,
        }
        return {"summary": summary, "cell_features": met}

    def cleanup_cache(self):
        FakeFetcher.cleaned = True


@pytest.fixture(scope="module")
def predictor():
    return ThermalPredictor()


def run(tmp_path, now, predictor, previous=None, run_hour=None):
    FakeFetcher.fetched = []
    published = []
    payload = run_pipeline(
        now_utc=now,
        cache_file=tmp_path / "forecast.json",
        dev_copy=None,
        fetcher_factory=FakeFetcher,
        latest_run=lambda now_utc: now_utc.replace(minute=0, second=0, microsecond=0, hour=run_hour or now_utc.hour),
        load_previous=lambda cache_file: previous,
        publish=published.append,
        predictor=predictor,
    )
    return payload, published


# 2026-07-15 20:30 UTC is 14:30 MDT in Boise.
SUMMER_AFTERNOON = datetime(2026, 7, 15, 20, 30, tzinfo=timezone.utc)


def test_a_cold_start_forecasts_every_hour_of_both_days(tmp_path, predictor):
    payload, published = run(tmp_path, SUMMER_AFTERNOON, predictor)
    assert payload["schema"] == SCHEMA
    assert len(payload["cells"]) == 690
    for key, date in (("today", "2026-07-15"), ("yesterday", "2026-07-14")):
        day = payload["days"][key]
        assert day["date_iso"] == date and day["supported"]
        assert [h["hour_local"] for h in day["hours"]] == DAYTIME_HOURS_LOCAL
    noon = payload["days"]["today"]["hours"][4]
    assert noon["hour_local"] == 12 and noon["is_daylight"]
    assert len(noon["lightgbm"]) == 690 and all(0 <= p <= 1000 for p in noon["lightgbm"])
    assert len(FakeFetcher.fetched) == 26 and FakeFetcher.cleaned
    assert len(published) == 1 and json.loads(published[0]) == payload


def test_the_payload_is_small(tmp_path, predictor):
    _, published = run(tmp_path, SUMMER_AFTERNOON, predictor)
    # 26 hours x 690 cells; the first version of this file was about 15 MB.
    assert len(published[0]) < 400_000


def test_hours_that_have_passed_keep_their_forecast(tmp_path, predictor):
    first, _ = run(tmp_path, SUMMER_AFTERNOON, predictor)
    later = SUMMER_AFTERNOON.replace(hour=22)  # 16:30 MDT, with a newer HRRR run
    second, _ = run(tmp_path, later, predictor, previous=first)
    # Only 16:00 to 20:00 today are fetched again.
    assert FakeFetcher.fetched == [f"2026-07-15 {h}" for h in range(16, 21)]
    today_1, today_2 = first["days"]["today"]["hours"], second["days"]["today"]["hours"]
    assert today_2[:8] == today_1[:8]
    assert second["days"]["yesterday"] == first["days"]["yesterday"]
    assert second["metadata"]["frozen_hours_count"] == 13 + 8


def test_after_midnight_today_becomes_yesterday(tmp_path, predictor):
    first, _ = run(tmp_path, SUMMER_AFTERNOON, predictor)
    next_morning = datetime(2026, 7, 16, 13, 30, tzinfo=timezone.utc)  # 07:30 MDT on the 16th
    second, _ = run(tmp_path, next_morning, predictor, previous=first)
    assert second["days"]["yesterday"]["date_iso"] == "2026-07-15"
    assert second["days"]["yesterday"]["hours"] == first["days"]["today"]["hours"]
    assert FakeFetcher.fetched == [f"2026-07-16 {h:02d}" for h in DAYTIME_HOURS_LOCAL]


def test_out_of_season_nothing_is_forecast_or_fetched(tmp_path, predictor):
    november = datetime(2026, 11, 25, 20, 30, tzinfo=timezone.utc)
    payload, published = run(tmp_path, november, predictor)
    assert FakeFetcher.fetched == []
    for day in payload["days"].values():
        assert day["supported"] is False and day["hours"] == []
    assert payload["metadata"]["season"] == {"first_month": 3, "last_month": 9}
    assert len(published) == 1


def test_on_the_first_day_out_of_season_yesterday_is_still_shown(tmp_path, predictor):
    october_first = datetime(2026, 10, 1, 20, 30, tzinfo=timezone.utc)
    payload, _ = run(tmp_path, october_first, predictor)
    assert payload["days"]["today"]["supported"] is False
    assert payload["days"]["yesterday"]["supported"] is True
    assert len(payload["days"]["yesterday"]["hours"]) == 13
