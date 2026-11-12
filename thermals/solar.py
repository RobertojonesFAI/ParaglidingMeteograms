"""
Solar astronomical calculations using pvlib for the Boise domain.
Derives solar angles, day/night cycles, absorbed radiation, and solar-slope interactions.
"""

import math
from datetime import datetime, timezone
import pandas as pd
import pvlib
import pytz

try:
    from .config import BOISE_CENTER_LAT, BOISE_CENTER_LON, BOISE_TIMEZONE
except ImportError:
    from config import BOISE_CENTER_LAT, BOISE_CENTER_LON, BOISE_TIMEZONE


def get_solar_context(dt_utc: datetime):
    """
    Computes solar position metrics for the Boise domain at the given UTC datetime.
    """
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)

    tz_boise = pytz.timezone(BOISE_TIMEZONE)
    dt_local = dt_utc.astimezone(tz_boise)

    times = pd.DatetimeIndex([dt_utc])
    solpos = pvlib.solarposition.get_solarposition(
        time=times,
        latitude=BOISE_CENTER_LAT,
        longitude=BOISE_CENTER_LON,
    )

    zenith = float(solpos["zenith"].iloc[0])
    azimuth = float(solpos["azimuth"].iloc[0])
    elevation = float(solpos["elevation"].iloc[0])

    day_start = dt_local.replace(hour=0, minute=0, second=0, microsecond=0)
    day_times = pd.date_range(day_start, periods=24 * 4, freq="15min", tz=tz_boise)
    day_sol = pvlib.solarposition.get_solarposition(day_times, BOISE_CENTER_LAT, BOISE_CENTER_LON)
    noon_idx = day_sol["elevation"].idxmax()
    solar_noon_hour = noon_idx.hour + noon_idx.minute / 60.0

    hour_of_day = dt_local.hour + dt_local.minute / 60.0
    hours_past_solar_noon = abs(hour_of_day - solar_noon_hour)
    month = float(dt_local.month)
    is_daylight = elevation > 0.0

    return {
        "dt_utc": dt_utc.isoformat(),
        "dt_local": dt_local.isoformat(),
        "local_time_str": dt_local.strftime("%I:%M %p %Z"),
        "hour_of_day": round(hour_of_day, 2),
        "month": month,
        "solar_noon_hour": round(solar_noon_hour, 2),
        "hours_past_solar_noon": round(hours_past_solar_noon, 2),
        "sun_azimuth_deg": round(azimuth, 2),
        "sun_elevation_deg": round(elevation, 2),
        "sun_zenith_deg": round(zenith, 2),
        "is_daylight": is_daylight,
    }


def compute_solar_terrain_interactions(
    solar_ctx: dict,
    slope_deg: float,
    aspect_deg: float,
    south_facing_fraction: float,
    albedo: float = 0.15,
):
    """
    Computes angle of incidence, absorbed radiation, and training feature interaction terms.
    """
    if not solar_ctx["is_daylight"]:
        return {
            "cos_incidence": 0.0,
            "absorbed_radiation": 0.0,
            "slope_x_solar": 0.0,
            "solar_x_south_facing": 0.0,
        }

    sun_elev_rad = math.radians(solar_ctx["sun_elevation_deg"])
    sun_az_rad = math.radians(solar_ctx["sun_azimuth_deg"])
    slope_rad = math.radians(slope_deg)
    aspect_rad = math.radians(aspect_deg)

    cos_inc = (
        math.cos(slope_rad) * math.sin(sun_elev_rad)
        + math.sin(slope_rad) * math.cos(sun_elev_rad) * math.cos(sun_az_rad - aspect_rad)
    )
    cos_inc = max(0.0, min(1.0, cos_inc))

    absorbed_radiation = cos_inc * (1.0 - min(0.9, max(0.05, albedo)))
    slope_x_solar = slope_deg * cos_inc
    solar_x_south_facing = math.sin(sun_elev_rad) * south_facing_fraction

    return {
        "cos_incidence": round(cos_inc, 4),
        "absorbed_radiation": round(absorbed_radiation, 4),
        "slope_x_solar": round(slope_x_solar, 4),
        "solar_x_south_facing": round(solar_x_south_facing, 4),
    }

