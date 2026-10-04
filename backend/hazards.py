"""
Natural hazards that could strike this campus, most likely first.

Two things are kept apart on purpose:

  * How likely a hazard is HERE comes from data: the county's saved hazard
    profile in data/hazards/{fips}.json (FEMA National Risk Index and the
    NOAA Storm Events Database).
  * What the hazard does to the campus feeds is this model's assumption,
    written down in EFFECTS with its reason, and shown to the user as assumed.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

# The campus the engine models. Washtenaw County, Michigan.
CAMPUS_FIPS = "26161"
PROFILE_DIR = Path(__file__).resolve().parent / "data" / "hazards"

# Used only until a saved profile exists. Counts are NOAA Storm Events, Washtenaw County, 1996-2026.
FALLBACK_COUNTS = {
    "thunderstorm_wind": 376,
    "high_wind": 39,
    "heavy_snow": 35,
    "winter_storm": 21,
    "riverine_flood": 21,
    "extreme_heat": 12,
    "extreme_cold": 10,
    "tornado": 7,
    "ice_storm": 4,
}
FALLBACK_YEARS = 30

NAMES = {
    "thunderstorm_wind": "Severe thunderstorm",
    "high_wind": "High wind",
    "tornado": "Tornado",
    "ice_storm": "Ice storm",
    "heavy_snow": "Heavy snow",
    "winter_storm": "Winter storm",
    "extreme_heat": "Extreme heat",
    "extreme_cold": "Extreme cold",
    "riverine_flood": "River flooding",
    "flash_flood": "Flash flooding",
    "coastal_flood": "Coastal flooding",
    "hurricane": "Hurricane",
    "earthquake": "Earthquake",
    "wildfire": "Wildfire",
}

# What each hazard is assumed to do to THIS campus's feeds, and why. The reasons
# follow the documented cases in data/hazards/consequences.json.
# North Campus and the hospital take overhead utility feeds; Central Campus is
# fed underground from the Central Power Plant, which burns natural gas.
_OVERHEAD_PARTIAL = {
    "label": "North feed at 50%",
    "why": "Falling trees take out overhead utility lines, so the feed into North Campus is hit. Central Campus is fed underground from its own plant and rides through, as the University of Iowa's plant did in the 2020 derecho.",
    "steps": [{"node_ids": ["north_switch"], "action": "derate", "factor": 0.5}],
}
EFFECTS: dict[str, dict[str, Any]] = {
    "thunderstorm_wind": _OVERHEAD_PARTIAL,
    "high_wind": _OVERHEAD_PARTIAL,
    "heavy_snow": {
        "label": "Wet snow: north feed at 70%",
        "why": "Dry snow rarely cuts power. This run assumes the wet, heavy kind that loads overhead lines. The larger real effect is on movement: buses stop for one to three days.",
        "steps": [{"node_ids": ["north_switch"], "action": "derate", "factor": 0.7}],
    },
    "ice_storm": {
        "label": "North campus feed down",
        "why": "Ice brings down overhead utility lines for days: about 3,000 wires in Michigan in February 2023. Underground distribution and the plant are not damaged.",
        "steps": [{"node_ids": ["north_switch"], "action": "fail"}],
    },
    "tornado": {
        "label": "A track across North Campus: feed down, research complex hit",
        "why": "A tornado destroys what is in its path and little outside it. This run assumes the path crosses North Campus. Most warnings end with no damage at all.",
        "steps": [{"node_ids": ["north_switch", "ncrc"], "action": "fail"}],
    },
    "extreme_heat": {
        "label": "Utility calls for cuts: both feeds at 70%",
        "why": "Heat rarely causes a blackout. The realistic strain is a short call to cut load while cooling demand peaks, as in California in 2020, and people in halls with no air conditioning.",
        "steps": [{"node_ids": ["cpp", "north_switch"], "action": "derate", "factor": 0.7}],
    },
    "extreme_cold": {
        "label": "Gas curtailed: power plant at 60%",
        "why": "Cold does not knock down lines. Outages come from generation and gas supply, as in Texas in 2021. The plant burns natural gas, and Michigan curtailed large gas users in January 2019.",
        "steps": [{"node_ids": ["cpp"], "action": "derate", "factor": 0.6}],
    },
}

# FEMA National Risk Index ratings, lowest to highest.
RATING_RANK = {"Very Low": 1, "Relatively Low": 2, "Relatively Moderate": 3, "Relatively High": 4, "Very High": 5}

# National Weather Service alert names that mean one of these hazards is under way.
ALERT_EVENTS = {
    "Tornado Warning": "tornado",
    "Severe Thunderstorm Warning": "thunderstorm_wind",
    "High Wind Warning": "high_wind",
    "Ice Storm Warning": "ice_storm",
    "Winter Storm Warning": "winter_storm",
    "Blizzard Warning": "heavy_snow",
    "Heat Advisory": "extreme_heat",
    "Excessive Heat Warning": "extreme_heat",
    "Extreme Heat Warning": "extreme_heat",
    "Extreme Cold Warning": "extreme_cold",
    "Wind Chill Warning": "extreme_cold",
    "Flood Warning": "riverine_flood",
    "Flash Flood Warning": "flash_flood",
}


@lru_cache(maxsize=1)
def _profile() -> dict[str, Any] | None:
    path = PROFILE_DIR / f"{CAMPUS_FIPS}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


@lru_cache(maxsize=1)
def _consequences() -> dict[str, dict[str, Any]]:
    """What each hazard does to a campus, from documented events. Optional."""
    path = PROFILE_DIR / "consequences.json"
    if not path.exists():
        return {}
    try:
        return {item["id"]: item for item in json.loads(path.read_text())}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def _how_often(per_year: float | None) -> str:
    if not per_year or per_year <= 0:
        return "no record in this county"
    if per_year >= 0.67:
        return f"about {max(1, round(per_year))} a year in this county"
    return f"about one every {round(1 / per_year)} years in this county"


def _from_profile(profile: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for h in profile.get("hazards") or []:
        events = h.get("storm_events") or {}
        # The local record gives one unit for every hazard. FEMA's own frequency
        # mixes events, event-days and probabilities, so it is only the fallback.
        span = events.get("span_years") or 0
        per_year = events["count"] / span if events.get("count") and span else h.get("annual_frequency")
        rows.append({
            "id": h.get("id"),
            "name": h.get("name"),
            "per_year": per_year,
            "how_often": _how_often(per_year),
            "risk_rating": h.get("nri_risk_rating"),
            "events": events.get("count"),
            "events_years": events.get("years"),
            "worst_local_event": h.get("worst_local_event"),
        })
    return rows


def _fallback() -> list[dict[str, Any]]:
    return [
        {
            "id": hid, "name": NAMES[hid], "per_year": count / FALLBACK_YEARS,
            "how_often": _how_often(count / FALLBACK_YEARS), "risk_rating": None,
            "events": count, "events_years": "1996-2026", "worst_local_event": None,
        }
        for hid, count in FALLBACK_COUNTS.items()
    ]


def list_hazards() -> dict[str, Any]:
    """Hazards for this campus. Ones this model can simulate come first, most likely first."""
    profile = _profile()
    rows = _from_profile(profile) if profile else _fallback()
    detail = _consequences()
    hazards = []
    for row in rows:
        hid = row["id"]
        # High wind is filed with thunderstorm wind in the consequence catalog.
        extra = detail.get(hid) or detail.get({"high_wind": "thunderstorm_wind", "winter_storm": "heavy_snow"}.get(hid, ""), {})
        sim = extra.get("sim_effect") or {}
        hazards.append({
            **row,
            "name": NAMES.get(hid, row.get("name") or hid),
            "effect": EFFECTS.get(hid),
            "summary": extra.get("summary"),
            "warning_time": extra.get("warning_time"),
            "typical_duration": extra.get("typical_duration"),
            "consequences": [
                {"system": c.get("system"), "what": c.get("what"), "timescale": c.get("timescale"), "source": c.get("source")}
                for c in (extra.get("consequences") or [])
                if c.get("likelihood") == "typical"
            ][:5],
            "people": sim.get("people"),
            "transit": sim.get("transit"),
            "decisions": (extra.get("decisions") or [])[:3],
            "does_not": (extra.get("does_not") or [])[:2],
            "precedents": [
                {"where": e.get("where"), "when": e.get("when"), "what": e.get("what"), "source": e.get("source")}
                for e in (extra.get("campus_examples") or [])[:2]
            ],
        })
    # A winter storm and heavy snow do the same thing here, so keep the more common one.
    ids = {h["id"] for h in hazards}
    if {"winter_storm", "heavy_snow"} <= ids:
        hazards = [h for h in hazards if h["id"] != "winter_storm"]
    # Simulable first, then FEMA's risk rating for the county, then how often it happens.
    hazards.sort(key=lambda h: (h["effect"] is None, -RATING_RANK.get(h["risk_rating"] or "", 0), -(h["per_year"] or 0)))
    return {
        "place": f"{profile['county']} County, {profile['state']}" if profile else "Washtenaw County, MI",
        "sources": "FEMA National Risk Index rating, then NOAA Storm Events frequency" if profile else "NOAA Storm Events Database, 1996-2026",
        "hazards": hazards,
    }


def hazard(hazard_id: str) -> dict[str, Any] | None:
    return next((h for h in list_hazards()["hazards"] if h["id"] == hazard_id), None)


def for_alert(event: str) -> str | None:
    return ALERT_EVENTS.get(event)
