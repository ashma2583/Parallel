"""
Natural-hazard profile for any US county, so a campus is offered the scenarios
that could really happen there, most likely first.

Live: FEMA's National Risk Index (NRI) county layer, a public ArcGIS feature
service that needs no key. A point becomes a county through the Census
geocoder, with the NRI layer itself as a fallback.
Saved: data/hazards/{fips}.json, which adds 30 years of NOAA Storm Events
counts and the worst local event per hazard (too heavy to fetch per request).

Nothing here raises on a network failure: callers get None or a profile with
"available": false.
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("parallel.hazards")

NRI_LAYER = (
    "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/"
    "National_Risk_Index_Counties/FeatureServer/0"
)
NRI_PAGE = "https://hazards.fema.gov/nri/map"
CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
FCC_URL = "https://geo.fcc.gov/api/census/block/find"
HEADERS = {"User-Agent": "PARALLEL campus twin (github.com/ashma2583/MHacks2026)"}
TIMEOUT = 12
DATA_DIR = Path(__file__).resolve().parent / "data" / "hazards"

# Our hazard id -> (display name, NRI prefix or None, whether NRI frequency applies to it).
# NRI folds several Storm Events types into one hazard: Strong Wind covers thunderstorm
# and high wind, Winter Weather covers winter storms and heavy snow, Inland Flooding
# covers river and flash floods. The sibling gets the rating but not the frequency.
HAZARDS: dict[str, tuple[str, str | None, bool]] = {
    "tornado": ("Tornado", "TRND", True),
    "thunderstorm_wind": ("Thunderstorm wind", "SWND", True),
    "high_wind": ("High wind", "SWND", False),
    "hail": ("Hail", "HAIL", True),
    "lightning": ("Lightning", "LTNG", True),
    "ice_storm": ("Ice storm", "ISTM", True),
    "winter_storm": ("Winter storm", "WNTW", True),
    "heavy_snow": ("Heavy snow", "WNTW", False),
    "extreme_heat": ("Extreme heat", "HWAV", True),
    "extreme_cold": ("Extreme cold", "CWAV", True),
    "riverine_flood": ("River flooding", "IFLD", True),
    "flash_flood": ("Flash flood", "IFLD", False),
    "coastal_flood": ("Coastal flooding", "CFLD", True),
    "hurricane": ("Hurricane / tropical storm", "HRCN", True),
    "earthquake": ("Earthquake", "ERQK", True),
    "wildfire": ("Wildfire", "WFIR", True),
    "drought": ("Drought", "DRGT", True),
    "landslide": ("Landslide", "LNDS", True),
}

# How NRI counts each hazard's annualized frequency.
DAY_COUNTED = {"HWAV", "CWAV", "DRGT", "WNTW"}  # event-days per year
PROBABILITY = {"ERQK", "WFIR"}  # annual probability, not a count

RATINGS = ["Very Low", "Relatively Low", "Relatively Moderate", "Relatively High", "Very High"]
NOT_RATED = {None, "", "Not Applicable", "No Rating", "Insufficient Data", "No Expected Annual Losses"}

STATES = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
    "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
    "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
    "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
}

NOTES = (
    "NRI ratings and frequencies are county-wide and compare the county with all US counties; "
    "they are not specific to the campus. NRI frequency units differ by hazard (events per year, "
    "event-days per year for heat, cold, drought and winter weather, annual probability for "
    "earthquake and wildfire). NRI Strong Wind, Winter Weather and Inland Flooding each cover two "
    "of our hazards, so the second one carries the rating only. Storm Events zone reports can "
    "cover a forecast zone larger than the county. Likelihood (chance of at least one event a year) "
    "and the order are computed by PARALLEL, not FEMA: from the local Storm Events rate when there "
    "is one, otherwise from NRI frequency capped at 0.5; ties go to the higher NRI rating."
)


async def county_for(lat: float, lng: float) -> dict[str, Any] | None:
    """{"fips", "county", "state"} for a point, or None if every geocoder fails."""
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS) as client:
        for lookup in (_census_county, _nri_county, _fcc_county):
            try:
                found = await lookup(client, lat, lng)
                if found:
                    return found
            except Exception as exc:  # noqa: BLE001 - try the next geocoder
                log.warning("%s failed: %s", lookup.__name__, exc)
    return None


async def _census_county(client: httpx.AsyncClient, lat: float, lng: float) -> dict[str, Any] | None:
    params = {
        "x": lng, "y": lat, "benchmark": "Public_AR_Current", "vintage": "Current_Current",
        "layers": "Counties", "format": "json",
    }
    r = await client.get(CENSUS_URL, params=params)
    counties = r.json()["result"]["geographies"].get("Counties") or []
    if not counties:
        return None
    c = counties[0]
    return {"fips": c["GEOID"], "county": c.get("BASENAME") or c["NAME"], "state": STATES.get(c["STATE"], c["STATE"])}


async def _nri_county(client: httpx.AsyncClient, lat: float, lng: float) -> dict[str, Any] | None:
    # The NRI layer is a polygon layer, so a point-in-polygon query is a geocoder too.
    params = {
        "geometry": f"{lng},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "STCOFIPS,COUNTY,STATEABBRV",
        "returnGeometry": "false", "f": "json",
    }
    r = await client.get(f"{NRI_LAYER}/query", params=params)
    features = r.json().get("features") or []
    if not features:
        return None
    a = features[0]["attributes"]
    return {"fips": a["STCOFIPS"], "county": a["COUNTY"], "state": a["STATEABBRV"]}


async def _fcc_county(client: httpx.AsyncClient, lat: float, lng: float) -> dict[str, Any] | None:
    r = await client.get(FCC_URL, params={"latitude": lat, "longitude": lng, "format": "json"})
    body = r.json()
    county, state = body.get("County") or {}, body.get("State") or {}
    if not county.get("FIPS"):
        return None
    name = str(county.get("name") or "").removesuffix(" County")
    return {"fips": county["FIPS"], "county": name, "state": state.get("code")}


async def fetch_nri(fips: str) -> dict[str, Any] | None:
    """The raw NRI attribute row for a county, or None."""
    params = {"where": f"STCOFIPS='{_clean(fips)}'", "outFields": "*", "returnGeometry": "false", "f": "json"}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS) as client:
            r = await client.get(f"{NRI_LAYER}/query", params=params)
        features = r.json().get("features") or []
        return features[0]["attributes"] if features else None
    except Exception as exc:  # noqa: BLE001 - hazards must never take the console down
        log.warning("NRI fetch failed for %s: %s", fips, exc)
        return None


async def fetch_profile(fips: str) -> dict[str, Any]:
    """Live NRI profile. Storm Events history is merged in from the saved file when there is one."""
    fips = _clean(fips)
    saved = load_profile(fips)
    attrs = await fetch_nri(fips)
    if attrs is None:
        if saved:
            return {**saved, "available": True, "live": False}
        return {"fips": fips, "available": False, "hazards": [], "notes": "NRI could not be reached."}
    storm = {h["id"]: h for h in (saved or {}).get("hazards", []) if h.get("storm_events")}
    profile = build_profile(attrs, storm, campus=(saved or {}).get("campus"))
    profile["live"] = True
    return profile


def load_profile(fips: str) -> dict[str, Any] | None:
    path = DATA_DIR / f"{_clean(fips)}.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def build_profile(attrs: dict[str, Any], storm: dict[str, dict[str, Any]] | None = None,
                  campus: str | None = None) -> dict[str, Any]:
    """Join an NRI row with optional Storm Events entries ({id: {"storm_events", "worst_local_event"}})."""
    storm = storm or {}
    hazards = []
    for hid, (name, prefix, owns_freq) in HAZARDS.items():
        rating = attrs.get(f"{prefix}_RISKR") if prefix else None
        rating = None if rating in NOT_RATED else rating
        freq = attrs.get(f"{prefix}_AFREQ") if prefix and owns_freq else None
        freq = round(freq, 4) if isinstance(freq, (int, float)) and freq > 0 else None
        se = storm.get(hid) or {}
        events = se.get("storm_events")
        if not (events and events.get("count")) and _rank(rating) < 3:
            continue  # nothing recorded locally and NRI rates it low
        hazards.append({
            "id": hid,
            "name": name,
            "nri_risk_rating": rating,
            "annual_frequency": freq,
            "frequency_note": _frequency_note(prefix, freq, events),
            "storm_events": events or None,
            "worst_local_event": se.get("worst_local_event"),
            "likelihood": round(_likelihood(prefix, freq, events), 3),
        })
    hazards.sort(key=lambda h: (round(h["likelihood"], 1), _rank(h["nri_risk_rating"]), h["likelihood"]), reverse=True)
    return {
        "fips": attrs.get("STCOFIPS"),
        "county": attrs.get("COUNTY"),
        "state": attrs.get("STATEABBRV"),
        "campus": campus,
        "available": True,
        "nri": {
            "version": attrs.get("NRI_VER"),
            "overall_rating": attrs.get("RISK_RATNG"),
            "source_url": f"{NRI_LAYER}/query?where=STCOFIPS%3D%27{attrs.get('STCOFIPS')}%27&outFields=*&f=json",
        },
        "hazards": hazards,
        "notes": NOTES,
    }


def _likelihood(prefix: str | None, freq: float | None, events: dict[str, Any] | None) -> float:
    """Chance of at least one occurrence in a year.

    The local Storm Events record comes first: it counts reported, impactful events in one
    unit for every hazard. NRI frequencies mix units (strikes, event-days, probabilities),
    so they only stand in when nothing was reported locally, and then at most 0.5,
    because 30 quiet years say the reportable kind is not common.
    """
    if events and events.get("count") and events.get("span_years"):
        return 1 - math.exp(-events["count"] / events["span_years"])
    if not freq:
        return 0.0
    p = min(freq, 1.0) if prefix in PROBABILITY else 1 - math.exp(-freq)
    return min(p, 0.5)


def _frequency_note(prefix: str | None, freq: float | None, events: dict[str, Any] | None) -> str:
    if events and events.get("count") and events.get("span_years"):
        return f"{_per_year(events['count'] / events['span_years'])} reported in the county ({events['count']} in {events['years']})"
    if freq and prefix in PROBABILITY:
        return f"about a {_pct(freq)} chance in a given year (NRI)"
    if freq and prefix in DAY_COUNTED:
        return f"about {_count(freq)} affected days a year in the county (NRI)"
    if freq:
        return f"{_per_year(freq)} in the county (NRI)"
    return "rated by NRI; no local count"


def _per_year(rate: float) -> str:
    if rate >= 1.5:
        return f"about {_count(rate)} a year"
    if rate >= 0.75:
        return "about once a year"
    if rate >= 0.5:
        return "most years"
    return f"about one every {round(1 / rate):,} years" if rate > 0 else "none recorded"


def _count(x: float) -> str:
    return f"{x:,.0f}" if x >= 10 else f"{x:.1f}".removesuffix(".0")


def _pct(p: float) -> str:
    pct = p * 100
    return f"{pct:.1f}%" if pct >= 0.1 else f"{pct:.2f}%"


def _rank(rating: str | None) -> int:
    return RATINGS.index(rating) + 1 if rating in RATINGS else 0


def _clean(fips: str) -> str:
    # Five digits only, so the value is safe inside the ArcGIS where clause.
    digits = "".join(c for c in str(fips) if c.isdigit())
    return digits.zfill(5)[-5:]
