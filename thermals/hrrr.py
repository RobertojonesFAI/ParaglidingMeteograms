"""
Real NOAA HRRR Weather Forecast Fetcher & Spatial Meteorology Engine (Boise Domain).
Uses Herbie (AWS noaa-hrrr-bdp-pds) with byte-range .idx downloads and cKDTree
spatial mapping across all 690 Boise terrain grid cells.
"""

import logging
import math
import shutil
import warnings
from datetime import datetime, timedelta, timezone
import numpy as np
import pytz
from scipy.spatial import cKDTree
from herbie import Herbie

try:
    from .config import (
        DATA_DIR,
        BOISE_TIMEZONE,
        DAYTIME_HOURS_LOCAL,
    )
    from .solar import get_solar_context
except ImportError:
    from config import (
        DATA_DIR,
        BOISE_TIMEZONE,
        DAYTIME_HOURS_LOCAL,
    )
    from solar import get_solar_context

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

HRRR_CACHE_DIR = DATA_DIR / "hrrr_cache"

# All required surface fields + standard pressure levels included in HRRR `sfc` product
SFC_REGEX = (
    ":(?:HPBL|CAPE|CIN|SHTFL|FRICV|SFCR|GUST|HGT|DSWRF|USWRF|DLWRF|ULWRF|VBDSF|VDDSF):surface:"
    "|:(?:TMP|DPT):2 m above ground:"
    "|:(?:UGRD|VGRD):10 m above ground:"
    "|:LFTX:500-1000 mb:"
    "|:(?:TMP|DPT|HGT|UGRD|VGRD):(?:250|300|500|700|850|925|1000) mb:"
)

# High-troposphere temperature/dewpoint/geopotential height from `prs` (for 8km-11km features)
PRS_UPPER_REGEX = ":(?:TMP|DPT|HGT):(?:200|250|300) mb:|:HGT:925 mb:|:(?:UGRD|VGRD):200 mb:"


def find_latest_available_hrrr_run(now_utc: datetime | None = None, max_lookback_hours: int = 8) -> datetime:
    """
    Probes AWS noaa-hrrr-bdp-pds to find the most recently published HRRR cycle.
    At ~7 min past UTC hour H, cycle H-1 has typically just finished publishing;
    falls back to H-2..H-max_lookback_hours if NOAA ingest is delayed.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    base_hour = now_utc.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    HRRR_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for offset in range(1, max_lookback_hours + 1):
        candidate = base_hour - timedelta(hours=offset)
        try:
            H = Herbie(
                candidate.strftime("%Y-%m-%d %H:%M"),
                model="hrrr",
                product="sfc",
                fxx=1,
                verbose=False,
                save_dir=str(HRRR_CACHE_DIR),
            )
            if H.idx is not None:
                logging.info(f"Selected latest available HRRR cycle: {candidate.strftime('%Y-%m-%d %H:00 UTC')}")
                return candidate
        except Exception as e:
            logging.debug(f"HRRR cycle {candidate} not ready: {e}")

    raise RuntimeError(f"No available NOAA HRRR cycle found in the last {max_lookback_hours} hours.")


def find_latest_synoptic_hrrr_run(reference_utc: datetime) -> datetime:
    """
    Finds the most recent synoptic HRRR cycle (00Z, 06Z, 12Z, 18Z), which forecasts out to 48 hours,
    used when a requested forecast lead time exceeds the 18-hour horizon of non-synoptic hourly runs.
    """
    base = reference_utc.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for offset in range(0, 14):
        cand = base - timedelta(hours=offset)
        if cand.hour in (0, 6, 12, 18):
            try:
                H = Herbie(
                    cand.strftime("%Y-%m-%d %H:%M"),
                    model="hrrr",
                    product="sfc",
                    fxx=19,
                    verbose=False,
                    save_dir=str(HRRR_CACHE_DIR),
                )
                if H.idx is not None:
                    return cand
            except Exception:
                continue
    return reference_utc


class HRRRBoiseFetcher:
    """
    Extracts spatially mapped HRRR surface & vertical profile features across the 690 Boise cells.
    """

    def __init__(self, terrain_cells: list[dict], run_time_utc: datetime):
        self.terrain_cells = terrain_cells
        self.run_time_utc = run_time_utc
        self.synoptic_run_utc = (
            run_time_utc
            if run_time_utc.hour in (0, 6, 12, 18)
            else find_latest_synoptic_hrrr_run(run_time_utc)
        )
        self.cell_iy = None
        self.cell_ix = None
        self._upper_prs_cache: dict[str, dict[str, np.ndarray]] = {}
        HRRR_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _ensure_grid_mapping(self, ds):
        if self.cell_iy is not None and self.cell_ix is not None:
            return
        lat2d = ds.latitude.values
        lon2d = ((ds.longitude.values + 180.0) % 360.0) - 180.0
        tree = cKDTree(np.column_stack((lat2d.ravel(), lon2d.ravel())))
        cell_coords = np.array([[c["lat"], c["lon"]] for c in self.terrain_cells], dtype=float)
        _, flat_idx = tree.query(cell_coords)
        iy, ix = np.unravel_index(flat_idx, lat2d.shape)
        self.cell_iy = iy
        self.cell_ix = ix
        unique_pts = len(set(zip(iy.tolist(), ix.tolist())))
        logging.info(f"Mapped {len(self.terrain_cells)} Boise cells onto {unique_pts} unique 3 km HRRR grid points.")

    def _resolve_cycle_and_fxx(self, valid_utc: datetime) -> tuple[datetime, int]:
        valid_utc_clean = valid_utc.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
        now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

        # Past hours (e.g. cold-start backfill): use the historical HRRR cycle near that valid time
        if valid_utc_clean < self.run_time_utc:
            # Prefer fxx=1 from (valid_utc - 1h) so accumulated/flux fields (DSWRF, SHTFL) are populated
            hist_cycle = valid_utc_clean - timedelta(hours=1)
            return hist_cycle, 1

        lead_hours = int(round((valid_utc_clean - self.run_time_utc).total_seconds() / 3600.0))
        max_lead = 48 if self.run_time_utc.hour in (0, 6, 12, 18) else 18

        if 1 <= lead_hours <= max_lead:
            return self.run_time_utc, lead_hours
        if lead_hours == 0:
            # Use fxx=1 from previous hour cycle so radiation/flux fields are non-zero
            prev_cycle = self.run_time_utc - timedelta(hours=1)
            return prev_cycle, 1

        # Lead exceeds 18h on a non-synoptic cycle -> fall back to latest synoptic 48h cycle
        syn_lead = int(round((valid_utc_clean - self.synoptic_run_utc).total_seconds() / 3600.0))
        syn_lead = max(1, min(48, syn_lead))
        return self.synoptic_run_utc, syn_lead

    def _fetch_upper_prs(self, cycle_utc: datetime, fxx: int) -> dict[str, dict[int, np.ndarray]]:
        """
        Fetches 200, 250, 300 mb TMP/DPT/HGT/U/V and 925 mb HGT from `prs` product.
        Cached per cycle date to minimize GRIB downloads while preserving full vertical profiles.
        """
        cache_key = f"{cycle_utc.strftime('%Y%m%d_%H')}_f{fxx:02d}"
        if cache_key in self._upper_prs_cache:
            return self._upper_prs_cache[cache_key]

        H_prs = Herbie(
            cycle_utc.strftime("%Y-%m-%d %H:%M"),
            model="hrrr",
            product="prs",
            fxx=fxx,
            verbose=False,
            save_dir=str(HRRR_CACHE_DIR),
        )
        ds_list = H_prs.xarray(PRS_UPPER_REGEX, remove_grib=True)
        if not isinstance(ds_list, list):
            ds_list = [ds_list]

        out: dict[str, dict[int, np.ndarray]] = {"t": {}, "dpt": {}, "gh": {}, "u": {}, "v": {}}
        for ds in ds_list:
            self._ensure_grid_mapping(ds)
            levels = ds.coords["isobaricInhPa"].values if "isobaricInhPa" in ds.coords else None
            for var in ("t", "dpt", "gh", "u", "v"):
                if var not in ds.data_vars:
                    continue
                arr = ds[var].values
                if levels is not None and arr.ndim == 3:
                    for idx_p, p_val in enumerate(np.atleast_1d(levels)):
                        out[var][int(round(float(p_val)))] = arr[idx_p, self.cell_iy, self.cell_ix].astype(float)
                elif levels is not None and arr.ndim == 2:
                    p_val = int(round(float(np.atleast_1d(levels)[0])))
                    out[var][p_val] = arr[self.cell_iy, self.cell_ix].astype(float)
            try:
                ds.close()
            except Exception:
                pass

        self._upper_prs_cache[cache_key] = out
        return out

    def fetch_hour(self, valid_local: datetime) -> dict:
        """
        Fetches real HRRR data for `valid_local` across all 690 Boise cells.
        Returns a dict containing `summary` (for the hourly weather bar) and
        `cell_features` (list of 690 dicts with all meteorological ML features).
        """
        valid_utc = valid_local.astimezone(timezone.utc)
        cycle_utc, fxx = self._resolve_cycle_and_fxx(valid_utc)

        logging.info(
            f"Fetching HRRR sfc+prs for valid={valid_local.strftime('%Y-%m-%d %H:%M %Z')} "
            f"(cycle={cycle_utc.strftime('%Y-%m-%d %HZ')} fxx={fxx:02d})..."
        )

        H_sfc = Herbie(
            cycle_utc.strftime("%Y-%m-%d %H:%M"),
            model="hrrr",
            product="sfc",
            fxx=fxx,
            verbose=False,
            save_dir=str(HRRR_CACHE_DIR),
        )
        ds_list = H_sfc.xarray(SFC_REGEX, remove_grib=True)
        if not isinstance(ds_list, list):
            ds_list = [ds_list]

        sfc_vars: dict[str, np.ndarray] = {}
        iso_vars: dict[str, dict[int, np.ndarray]] = {"t": {}, "dpt": {}, "gh": {}, "u": {}, "v": {}}

        for ds in ds_list:
            self._ensure_grid_mapping(ds)
            has_iso = "isobaricInhPa" in ds.coords
            levels = np.atleast_1d(ds.coords["isobaricInhPa"].values) if has_iso else None

            for var in ds.data_vars:
                arr = ds[var].values
                if has_iso and var in iso_vars:
                    if arr.ndim == 3:
                        for i_p, p_val in enumerate(levels):
                            iso_vars[var][int(round(float(p_val)))] = arr[i_p, self.cell_iy, self.cell_ix].astype(float)
                    elif arr.ndim == 2:
                        p_val = int(round(float(levels[0])))
                        iso_vars[var][p_val] = arr[self.cell_iy, self.cell_ix].astype(float)
                else:
                    if arr.ndim == 3:
                        sfc_vars[var] = arr[0, self.cell_iy, self.cell_ix].astype(float)
                    else:
                        sfc_vars[var] = arr[self.cell_iy, self.cell_ix].astype(float)
            try:
                ds.close()
            except Exception:
                pass

        # Merge upper-troposphere pressure levels (200, 250, 300, 925 mb) from prs
        upper_prs = self._fetch_upper_prs(cycle_utc, fxx)
        for var in ("t", "dpt", "gh", "u", "v"):
            for p_lvl, vals in upper_prs.get(var, {}).items():
                if p_lvl not in iso_vars[var]:
                    iso_vars[var][p_lvl] = vals

        n_cells = len(self.terrain_cells)
        t2m_k = sfc_vars["t2m"]
        d2m_k = sfc_vars["d2m"]
        t2m_c = t2m_k - 273.15
        d2m_c = d2m_k - 273.15

        u10 = sfc_vars["u10"]
        v10 = sfc_vars["v10"]
        wind_speed_ms = np.hypot(u10, v10)
        wind_dir_deg = (270.0 - np.degrees(np.arctan2(v10, u10))) % 360.0

        blh_sfc = sfc_vars["blh"]
        cape_sfc = sfc_vars["cape"]
        cin_sfc = sfc_vars["cin"]
        lftx_sfc = sfc_vars["lftx"]
        ishf_sfc = sfc_vars["ishf"]
        fricv_sfc = sfc_vars["fricv"]
        fsr_sfc = sfc_vars["fsr"]
        gust_subh = sfc_vars["gust"]
        orog_subh = sfc_vars["orog"]

        sdswrf = sfc_vars.get("sdswrf", np.zeros(n_cells))
        suswrf = sfc_vars.get("suswrf", np.zeros(n_cells))
        sdlwrf = sfc_vars.get("sdlwrf", np.zeros(n_cells))
        sulwrf = sfc_vars.get("sulwrf", np.zeros(n_cells))
        full_net_radiation = (sdswrf - suswrf) + (sdlwrf - sulwrf)

        vbdsf = sfc_vars.get("vbdsf", np.zeros(n_cells))
        vddsf = sfc_vars.get("vddsf", np.zeros(n_cells))
        rad_denom = vbdsf + vddsf
        diffuse_fraction = np.divide(
            vddsf,
            rad_denom,
            out=np.full(n_cells, 0.0965, dtype=float),
            where=rad_denom > 1.0,
        )

        # Build sorted vertical profile arrays across pressure levels: 1000 down to 200 hPa
        p_levels = sorted(
            [p for p in iso_vars["gh"].keys() if p in iso_vars["t"] and p in iso_vars["dpt"]],
            reverse=True,
        )
        # Shape: (n_levels, n_cells)
        gh_mat = np.vstack([iso_vars["gh"][p] for p in p_levels])
        t_mat_c = np.vstack([iso_vars["t"][p] - 273.15 for p in p_levels])
        dpt_mat_c = np.vstack([iso_vars["dpt"][p] - 273.15 for p in p_levels])
        p_mat = np.broadcast_to(np.array(p_levels, dtype=float)[:, None], gh_mat.shape)

        uv_levels = sorted(
            [p for p in iso_vars["gh"].keys() if p in iso_vars["u"] and p in iso_vars["v"]],
            reverse=True,
        )
        gh_uv_mat = np.vstack([iso_vars["gh"][p] for p in uv_levels])
        u_mat = np.vstack([iso_vars["u"][p] for p in uv_levels])
        v_mat = np.vstack([iso_vars["v"][p] for p in uv_levels])

        def interp_at_height(h_mat: np.ndarray, val_mat: np.ndarray, target_h: float) -> np.ndarray:
            out = np.empty(n_cells, dtype=float)
            for idx_c in range(n_cells):
                h_col = h_mat[:, idx_c]
                v_col = val_mat[:, idx_c]
                order = np.argsort(h_col)
                out[idx_c] = float(np.interp(target_h, h_col[order], v_col[order]))
            return out

        temp_1000 = interp_at_height(gh_mat, t_mat_c, 1000.0)
        temp_2500 = interp_at_height(gh_mat, t_mat_c, 2500.0)
        temp_8000 = interp_at_height(gh_mat, t_mat_c, 8000.0)

        dew_1000 = interp_at_height(gh_mat, dpt_mat_c, 1000.0)
        dew_4000 = interp_at_height(gh_mat, dpt_mat_c, 4000.0)
        dew_11000 = interp_at_height(gh_mat, dpt_mat_c, 11000.0)

        pres_2500 = interp_at_height(gh_mat, p_mat, 2500.0)
        pres_10000 = interp_at_height(gh_mat, p_mat, 10000.0)

        u_2000 = interp_at_height(gh_uv_mat, u_mat, 2000.0)
        u_6500 = interp_at_height(gh_uv_mat, u_mat, 6500.0)
        v_2000 = interp_at_height(gh_uv_mat, v_mat, 2000.0)
        v_7000 = interp_at_height(gh_uv_mat, v_mat, 7000.0)

        # Training Skew-T derived formulas from data_preparation_pipeline_multiregion.py
        low_temp = t2m_c
        low_dew = d2m_c

        tol_8000 = (low_temp - temp_8000) * 1000.0 / 8.0
        tol_1000 = (low_temp - temp_1000) * 1000.0 / 8.0

        dew_diff_1000 = dew_1000 - low_dew
        dew_diff_4000 = dew_4000 - low_dew
        dew_diff_11000 = dew_11000 - low_dew

        env_lapse_rate_1000 = dew_diff_1000 * 1000.0 / (1000.0 - 379.0)
        env_lapse_rate_4000 = dew_diff_4000 * 1000.0 / (4000.0 - 379.0)
        env_lapse_rate_11000 = dew_diff_11000 * 1000.0 / (11000.0 - 379.0)

        instability_1000 = env_lapse_rate_1000 - 9.8
        instability_11000 = env_lapse_rate_11000 - 9.8
        dew_height_4000 = dew_diff_4000 * 1000.0 / 9.8

        denom_inv = np.maximum(np.maximum(temp_1000, low_temp), 1.0)
        inversion_layer_1000 = (temp_1000 - low_temp) / denom_inv

        cell_features = []
        for i in range(n_cells):
            cell_features.append({
                "TOL_8000": float(tol_8000[i]),
                "TOL_1000": float(tol_1000[i]),
                "u_wind_6500": float(u_6500[i]),
                "u_wind_2000": float(u_2000[i]),
                "v_wind_7000": float(v_7000[i]),
                "v_wind_2000": float(v_2000[i]),
                "temperature_8000": float(temp_8000[i]),
                "temperature_2500": float(temp_2500[i]),
                "pressure_10000": float(pres_10000[i]),
                "pressure_2500": float(pres_2500[i]),
                "env_lapse_rate_4000": float(env_lapse_rate_4000[i]),
                "env_lapse_rate_11000": float(env_lapse_rate_11000[i]),
                "instability_1000": float(instability_1000[i]),
                "instability_11000": float(instability_11000[i]),
                "dew_height_4000": float(dew_height_4000[i]),
                "inversion_layer_1000": float(inversion_layer_1000[i]),
                "blh_sfc": float(blh_sfc[i]),
                "cape_sfc": float(cape_sfc[i]),
                "cin_sfc": float(cin_sfc[i]),
                "d2m_subh": float(d2m_k[i]),
                "diffuse_fraction": float(diffuse_fraction[i]),
                "fricv_sfc": float(fricv_sfc[i]),
                "fsr_sfc": float(fsr_sfc[i]),
                "full_net_radiation": float(full_net_radiation[i]),
                "gust_subh": float(gust_subh[i]),
                "ishf_sfc": float(ishf_sfc[i]),
                "lftx_sfc": float(lftx_sfc[i]),
                "orog_subh": float(orog_subh[i]),
                "wind_speed_ms": float(wind_speed_ms[i]),
                "wind_dir_deg": float(wind_dir_deg[i]),
            })

        mean_u10 = float(np.mean(u10))
        mean_v10 = float(np.mean(v10))
        mean_ws_ms = float(np.mean(wind_speed_ms))
        mean_wdir = float((270.0 - math.degrees(math.atan2(mean_v10, mean_u10))) % 360.0)
        mean_t2m_c = round(float(np.mean(t2m_c)), 1)

        solar_ctx = get_solar_context(valid_utc)
        summary = {
            "fxx": fxx,
            "cycle_utc": cycle_utc.isoformat(),
            "hour_local": valid_local.hour,
            "valid_utc": valid_utc.isoformat(),
            "valid_local": valid_local.isoformat(),
            "local_time_display": valid_local.strftime("%-I:%M %p"),
            "local_date_display": valid_local.strftime("%a, %b %-d"),
            "sun_elevation_deg": solar_ctx["sun_elevation_deg"],
            "is_daylight": solar_ctx["is_daylight"],
            "t2m_c": mean_t2m_c,
            "d2m_c": round(float(np.mean(d2m_c)), 1),
            "wind_speed_ms": round(mean_ws_ms, 1),
            "wind_speed_mph": round(mean_ws_ms * 2.23694, 1),
            "wind_dir_deg": round(mean_wdir, 0),
            "cape_sfc": round(float(np.mean(cape_sfc)), 1),
            "blh_sfc": round(float(np.mean(blh_sfc)), 1),
            "ishf_sfc": round(float(np.mean(ishf_sfc)), 1),
            "full_net_radiation": round(float(np.mean(full_net_radiation)), 1),
        }

        return {
            "summary": summary,
            "cell_features": cell_features,
        }

    def cleanup_cache(self):
        if HRRR_CACHE_DIR.exists():
            shutil.rmtree(HRRR_CACHE_DIR, ignore_errors=True)

