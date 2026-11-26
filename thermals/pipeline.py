"""
Hourly thermal forecast for the Boise domain, published as thermal_predictions.json.

- Fetches NOAA HRRR (via Herbie) for the day's hours, 8 AM to 8 PM, and runs
  the LightGBM and XGBoost models on all 690 terrain cells.
- Hours that have passed, and all of yesterday, are kept as they were last
  forecast, so they can be compared with what pilots found.
- Months the models were not trained on (they saw March to September) are not
  forecast: the day is published as out of season instead.
- If anything fails, nothing is published and the site keeps the last forecast.

Payload (schema 2):
    metadata   run, dates, default thresholds, the training season
    cells      the grid, once: id, lat, lon, elevation, slope, aspect, zone
    days       today and yesterday, each with `supported` and `hours`; every
               hour has LightGBM and XGBoost probabilities per cell in thousandths
               (null while the sun is down), the share of sunlight each cell
               absorbs in percent, the domain's weather and the inputs that were
               outside their training range
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytz

from .config import (
    BOISE_TIMEZONE,
    DAYTIME_HOURS_LOCAL,
    FORECAST_CACHE_FILE,
    GRID_RESOLUTION_DEG,
    HIGH_THRESHOLD,
    LOW_THRESHOLD,
    METEOGRAMS_DEV_DATA_DIR,
    METEOGRAMS_DEV_FORECAST_FILE,
    R2_FORECAST_KEY,
)
from .features import wind_terrain_features
from .solar import compute_solar_terrain_interactions, get_solar_context
from .terrain import load_terrain_grid

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

SCHEMA = 2
WEATHER_SOURCE_TAG = "noaa_hrrr_herbie"
TERRAIN_INPUTS = (
    "max_elevation", "mean_aspect", "mean_slope", "neighbor_max_elevation",
    "elevation_delta", "south_facing_fraction",
)


def _get_r2_client():
    bucket = os.environ.get("METEO_R2_BUCKET", "").strip()
    endpoint = (os.environ.get("R2_ENDPOINT") or os.environ.get("METEO_S3_ENDPOINT") or "").strip()
    access_key = (os.environ.get("R2_ACCESS_KEY_ID") or os.environ.get("AWS_ACCESS_KEY_ID") or "").strip()
    secret_key = (os.environ.get("R2_SECRET_ACCESS_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY") or "").strip()
    if not (bucket and endpoint and access_key and secret_key):
        return None, None
    import boto3
    from botocore.config import Config as BotoConfig

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )
    return s3, bucket


def _is_current_schema(payload) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("schema") == SCHEMA
        and payload.get("metadata", {}).get("weather_source") == WEATHER_SOURCE_TAG
    )


def load_previous_payload(cache_file: Path = FORECAST_CACHE_FILE) -> dict | None:
    """The last published payload, from R2 when configured, else the local cache."""
    s3, bucket = _get_r2_client()
    if s3 and bucket:
        try:
            body = s3.get_object(Bucket=bucket, Key=R2_FORECAST_KEY)["Body"].read()
            payload = json.loads(body)
            if _is_current_schema(payload):
                logging.info("Loaded the previous forecast from R2.")
                return payload
            logging.info("The forecast in R2 has another schema; building a fresh one.")
        except Exception as e:
            logging.info(f"No previous forecast in R2 ({e}).")
        return None

    if cache_file.exists():
        try:
            payload = json.loads(cache_file.read_text())
            if _is_current_schema(payload):
                logging.info(f"Loaded the previous forecast from {cache_file}.")
                return payload
        except Exception as e:
            logging.warning(f"Could not read {cache_file}: {e}")
    return None


def upload_payload_to_r2(payload_bytes: bytes) -> bool:
    s3, bucket = _get_r2_client()
    if not (s3 and bucket):
        logging.info("R2 is not configured; not publishing.")
        return False
    s3.put_object(
        Bucket=bucket,
        Key=R2_FORECAST_KEY,
        Body=payload_bytes,
        ContentType="application/json",
        CacheControl="public, max-age=300",
    )
    logging.info(f"Uploaded {R2_FORECAST_KEY} ({len(payload_bytes) / 1024.0:.1f} KB) to R2 bucket '{bucket}'.")
    return True


def _per_mille(probabilities: np.ndarray) -> list[int]:
    return [int(round(p * 1000.0)) for p in probabilities]


def compute_hour(valid_local: datetime, cells: list[dict], fetcher, predictor) -> dict:
    """Fetches HRRR for one hour and runs both models on every cell."""
    hrrr = fetcher.fetch_hour(valid_local)
    summary = hrrr["summary"]
    met = hrrr["cell_features"]
    solar = get_solar_context(valid_local.astimezone(timezone.utc))

    terrain = {name: np.array([c[name] for c in cells], dtype=float) for name in TERRAIN_INPUTS}
    interactions = [
        compute_solar_terrain_interactions(
            solar_ctx=solar,
            slope_deg=c["mean_slope"],
            aspect_deg=c["mean_aspect"],
            south_facing_fraction=c["south_facing_fraction"],
            albedo=c["albedo"],
        )
        for c in cells
    ]
    n = len(cells)
    features = pd.DataFrame({
        **{name: np.asarray(values, dtype=float) for name, values in met.items()},
        **terrain,
        **wind_terrain_features(
            aspect_deg=terrain["mean_aspect"],
            wind_dir_deg=np.asarray(met["wind_dir_deg"], dtype=float),
            wind_speed_ms=np.asarray(met["wind_speed_ms"], dtype=float),
            elevation_delta_m=terrain["elevation_delta"],
            instability_1000=np.asarray(met["instability_1000"], dtype=float),
        ),
        "hour_of_day": np.full(n, solar["hour_of_day"]),
        "month": np.full(n, solar["month"]),
        "hours_past_solar_noon": np.full(n, solar["hours_past_solar_noon"]),
        "absorbed_radiation": [i["absorbed_radiation"] for i in interactions],
        "slope_x_solar": [i["slope_x_solar"] for i in interactions],
        "solar_x_south_facing": [i["solar_x_south_facing"] for i in interactions],
    })

    lgbm, xgbm = predictor.predict(features)
    outside = predictor.inputs_outside_training(features)
    if outside:
        logging.warning(f"{valid_local:%H:%M}: inputs outside their training range: {', '.join(outside)}")

    daylight = bool(solar["is_daylight"])
    return {
        "hour_local": valid_local.hour,
        "valid_time_iso": valid_local.isoformat(),
        "local_time_display": valid_local.strftime("%-I:%M %p"),
        "is_daylight": daylight,
        "sun_elevation_deg": solar["sun_elevation_deg"],
        "hrrr": {"cycle_utc": summary["cycle_utc"], "fxx": summary["fxx"]},
        "weather_summary": {
            "temp_c": summary["t2m_c"],
            "dew_c": summary["d2m_c"],
            "wind_speed_mph": summary["wind_speed_mph"],
            "wind_dir_deg": summary["wind_dir_deg"],
            "cape_jkg": summary["cape_sfc"],
            "blh_m": summary["blh_sfc"],
            "sensible_heat_wm2": summary["ishf_sfc"],
            "net_radiation_wm2": summary["full_net_radiation"],
        },
        "inputs_outside_training": outside,
        # The models were trained on daytime data only.
        "lightgbm": _per_mille(lgbm) if daylight else None,
        "xgboost": _per_mille(xgbm) if daylight else None,
        "absorbed": [int(round(i["absorbed_radiation"] * 100.0)) for i in interactions],
    }


def _hours_by_local_hour(day_block: dict | None) -> dict[int, dict]:
    if not day_block or not day_block.get("supported"):
        return {}
    return {h["hour_local"]: h for h in day_block.get("hours", []) if isinstance(h, dict) and "hour_local" in h}


def validate_payload(payload: dict, expected_cells: int):
    if len(payload["cells"]) != expected_cells:
        raise ValueError(f"payload has {len(payload['cells'])} cells; expected {expected_cells}")
    for key in ("today", "yesterday"):
        day = payload["days"][key]
        hours = day["hours"]
        if not day["supported"]:
            if hours:
                raise ValueError(f"{key} is out of season but has hours")
            continue
        if [h["hour_local"] for h in hours] != DAYTIME_HOURS_LOCAL:
            raise ValueError(f"{key} has hours {[h['hour_local'] for h in hours]}; expected {DAYTIME_HOURS_LOCAL}")
        for h in hours:
            for name in ("lightgbm", "xgboost", "absorbed"):
                values = h[name]
                if values is None and name != "absorbed" and not h["is_daylight"]:
                    continue
                if not isinstance(values, list) or len(values) != expected_cells or not all(0 <= v <= 1000 for v in values):
                    raise ValueError(f"{key} {h['hour_local']}:00 has an invalid {name} array")


def run_pipeline(
    now_utc: datetime | None = None,
    force_refresh: bool = False,
    cache_file: Path = FORECAST_CACHE_FILE,
    dev_copy: Path | None = METEOGRAMS_DEV_FORECAST_FILE if METEOGRAMS_DEV_DATA_DIR.exists() else None,
    *,
    fetcher_factory=None,
    latest_run=None,
    load_previous=load_previous_payload,
    publish=upload_payload_to_r2,
    predictor=None,
) -> dict:
    """Builds, validates, saves and publishes the payload. The keyword-only
    arguments exist for tests; by default they reach NOAA and R2."""
    t_start = time.time()
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    elif now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    tz = pytz.timezone(BOISE_TIMEZONE)
    now_local = now_utc.astimezone(tz)
    yesterday_local = now_local - timedelta(days=1)
    current_hour_iso = now_local.strftime("%Y-%m-%dT%H:00")
    logging.info(f"Boise thermal forecast for {now_local:%Y-%m-%d %H:%M %Z}")

    if predictor is None:
        from .models_inference import ThermalPredictor
        predictor = ThermalPredictor()
    cells = load_terrain_grid()
    previous = load_previous(cache_file=cache_file)

    days_wanted = {
        "today": (now_local, predictor.season_supported(now_local.month)),
        "yesterday": (yesterday_local, predictor.season_supported(yesterday_local.month)),
    }
    in_season = any(supported for _, supported in days_wanted.values())

    run_time_utc = None
    fetcher = None
    if in_season:
        if latest_run is None:
            from .hrrr import find_latest_available_hrrr_run as latest_run
        run_time_utc = latest_run(now_utc)
        if (
            not force_refresh
            and previous is not None
            and previous["metadata"].get("current_hour_iso") == current_hour_iso
            and previous["metadata"].get("run_timestamp_utc") == run_time_utc.isoformat()
        ):
            logging.info("Already up to date for this hour and HRRR run.")
            return previous
        if fetcher_factory is None:
            from .hrrr import HRRRBoiseFetcher as fetcher_factory
        fetcher = fetcher_factory(terrain_cells=cells, run_time_utc=run_time_utc)
    else:
        logging.info("Out of the models' training season: publishing no forecast hours.")

    # The hours already forecast, by date.
    frozen: dict[str, dict[int, dict]] = {}
    if previous is not None:
        for block in previous["days"].values():
            frozen[block.get("date_iso")] = _hours_by_local_hour(block)

    frozen_count = 0
    updated_count = 0
    days = {}
    try:
        for key, (day_local, supported) in days_wanted.items():
            date_iso = day_local.strftime("%Y-%m-%d")
            hours = []
            if supported:
                kept = frozen.get(date_iso, {})
                for hour in DAYTIME_HOURS_LOCAL:
                    passed = key == "yesterday" or hour < now_local.hour
                    if passed and hour in kept:
                        hours.append(kept[hour])
                        frozen_count += 1
                        continue
                    valid_local = tz.localize(datetime(day_local.year, day_local.month, day_local.day, hour))
                    hours.append(compute_hour(valid_local, cells, fetcher, predictor))
                    updated_count += 1
            days[key] = {
                "date_iso": date_iso,
                "date_display": day_local.strftime("%a, %b %-d"),
                "supported": supported,
                "hours": hours,
            }
    finally:
        if fetcher is not None:
            fetcher.cleanup_cache()

    month_low, month_high = predictor.ranges["month"]
    payload = {
        "schema": SCHEMA,
        "metadata": {
            "weather_source": WEATHER_SOURCE_TAG,
            "model_run": f"HRRR {run_time_utc:%Y-%m-%d %H:00 UTC}" if run_time_utc else None,
            "run_timestamp_utc": run_time_utc.isoformat() if run_time_utc else None,
            "current_hour_iso": current_hour_iso,
            "retrieved_at_utc": now_utc.isoformat(),
            "retrieved_at_local": now_local.strftime("%b %-d, %Y at %-I:%M %p %Z"),
            "thresholds": {"low": LOW_THRESHOLD, "high": HIGH_THRESHOLD},
            "grid_resolution_deg": GRID_RESOLUTION_DEG,
            "season": {"first_month": int(month_low), "last_month": int(month_high)},
            "frozen_hours_count": frozen_count,
            "updated_hours_count": updated_count,
            "pipeline_runtime_sec": round(time.time() - t_start, 2),
        },
        "cells": [
            {
                "id": c["id"],
                "lat": c["lat"],
                "lon": c["lon"],
                "elevation": round(c["elevation"]),
                "slope": round(c["mean_slope"], 1),
                "aspect": round(c["mean_aspect"]),
                "zone": c["zone"],
            }
            for c in cells
        ],
        "days": days,
    }
    validate_payload(payload, expected_cells=len(cells))
    logging.info(f"{frozen_count} hours kept as forecast, {updated_count} computed.")

    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(payload_bytes)
    logging.info(f"Saved the forecast ({len(payload_bytes) / 1024.0:.1f} KB) to {cache_file}")
    if dev_copy is not None:
        dev_copy.write_bytes(payload_bytes)
        logging.info(f"Copied it to {dev_copy}")
    publish(payload_bytes)
    return payload


def main():
    parser = argparse.ArgumentParser(description="Run the Boise HRRR thermal forecast and publish it to R2.")
    parser.add_argument("--force", action="store_true", help="Recompute the remaining hours even if this hour is done.")
    args = parser.parse_args()
    try:
        run_pipeline(force_refresh=args.force)
    except Exception as exc:
        logging.error(f"Pipeline failed; the published forecast is unchanged: {exc}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
