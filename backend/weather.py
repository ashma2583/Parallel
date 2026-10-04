"""
Weather for Ann Arbor, from the National Weather Service.

Live: the current hourly forecast and any active alerts for the campus point.
Replays: real past warnings for Washtenaw County, kept in data/weather_replays.json.

An alert never breaks anything by itself. `EFFECTS` is this model's assumption
about what each kind of weather does to the campus feeds, and every payload
says so, so the UI can label it as assumed.
"""

from __future__ import annotations

import json
import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("parallel.weather")

# Central campus. api.weather.gov resolves it to office DTX, grid 43,29, zone MIZ075.
POINT = "42.278,-83.738"
FORECAST_URL = "https://api.weather.gov/gridpoints/DTX/43,29/forecast/hourly"
ALERTS_URL = f"https://api.weather.gov/alerts/active?point={POINT}"
# The service asks every client to identify itself.
HEADERS = {"User-Agent": "PARALLEL campus twin (github.com/ashma2583/MHacks2026)", "Accept": "application/geo+json"}
CACHE_SECONDS = 300
REPLAYS_PATH = Path(__file__).resolve().parent / "data" / "weather_replays.json"

HEAT = {
    "label": "Power plant at 35%, north feed at 50%",
    "why": "Heat cuts generator and feeder capacity while cooling load peaks.",
    "steps": [
        {"node_ids": ["cpp"], "action": "derate", "factor": 0.35},
        {"node_ids": ["north_switch"], "action": "derate", "factor": 0.5},
    ],
}
LINES_DOWN = {
    "label": "North campus feed down",
    "why": "North Campus is fed by overhead utility lines, which ice and falling trees bring down.",
    "steps": [{"node_ids": ["north_switch"], "action": "fail"}],
}
LINES_STRAINED = {
    "label": "North feed at 50%",
    "why": "Wind damage takes part of the overhead utility feed out of service.",
    "steps": [{"node_ids": ["north_switch"], "action": "derate", "factor": 0.5}],
}

# NWS event name -> what this model assumes it does. Anything else has no effect.
EFFECTS: dict[str, dict[str, Any]] = {
    "Heat Advisory": HEAT,
    "Excessive Heat Warning": HEAT,
    "Extreme Heat Warning": HEAT,
    "Ice Storm Warning": LINES_DOWN,
    "Tornado Warning": LINES_DOWN,
    "Winter Storm Warning": LINES_STRAINED,
    "High Wind Warning": LINES_STRAINED,
    "Severe Thunderstorm Warning": LINES_STRAINED,
}

_cache: dict[str, Any] = {"at": 0.0, "body": None}


def effect_for(event: str) -> dict[str, Any] | None:
    return EFFECTS.get(event)


@lru_cache(maxsize=1)
def replays() -> list[dict[str, Any]]:
    """Real past warnings, each with the effect this model assumes."""
    if not REPLAYS_PATH.exists():
        return []
    items = json.loads(REPLAYS_PATH.read_text()).get("replays") or []
    return [{**item, "what": _sentence(item.get("what", "")), "effect": effect_for(item["event"])} for item in items]


def replay(replay_id: str) -> dict[str, Any] | None:
    return next((item for item in replays() if item["id"] == replay_id), None)


async def current() -> dict[str, Any]:
    """Live conditions and alerts. Never raises: a failed fetch reports itself."""
    now = time.monotonic()
    if _cache["body"] is not None and now - _cache["at"] < CACHE_SECONDS:
        return _cache["body"]
    body: dict[str, Any] = {"available": False, "conditions": None, "alerts": [], "source": "National Weather Service"}
    try:
        async with httpx.AsyncClient(timeout=8, headers=HEADERS) as client:
            forecast, alerts = await client.get(FORECAST_URL), await client.get(ALERTS_URL)
        if forecast.status_code == 200:
            period = (forecast.json().get("properties", {}).get("periods") or [None])[0]
            if period:
                body["conditions"] = {
                    "temperature_f": period.get("temperature"),
                    "wind": period.get("windSpeed"),
                    "summary": period.get("shortForecast"),
                    "time": period.get("startTime"),
                }
        if alerts.status_code == 200:
            body["alerts"] = [_alert(f.get("properties") or {}) for f in alerts.json().get("features") or []]
        body["available"] = forecast.status_code == 200 or alerts.status_code == 200
    except Exception as exc:  # noqa: BLE001 - weather must never take the console down
        log.warning("weather fetch failed: %s", exc)
    # A failed fetch is retried sooner than a good one is refreshed.
    _cache.update(at=now if body["available"] else now - CACHE_SECONDS + 30, body=body)
    return body


def _alert(p: dict[str, Any]) -> dict[str, Any]:
    event = str(p.get("event") or "")
    return {
        "id": str(p.get("id") or event),
        "event": event,
        "severity": p.get("severity"),
        "headline": p.get("headline") or "",
        "what": _sentence(str(p.get("description") or ""))[:420],
        "instruction": _sentence(str(p.get("instruction") or ""))[:420],
        "issued": p.get("onset") or p.get("sent"),
        "expires": p.get("ends") or p.get("expires"),
        "office": p.get("senderName") or "National Weather Service",
        "effect": effect_for(event),
    }


def _sentence(text: str) -> str:
    """Older bulletins are in capitals. Lower them so they read like the rest of the page."""
    text = " ".join(text.replace("...", ". ").split())
    letters = [c for c in text if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) > 0.6 * len(letters):
        text = ". ".join(part.strip().capitalize() for part in text.split(". "))
    return text
