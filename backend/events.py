"""Campus events from Happening @ Michigan.

The public feed (https://events.umich.edu/week/2026-10-05/json?v=2) lists
occurrences but not how many people attend. A demo snapshot stores the week
of October 5, 2026, and each event type gets a fixed crowd estimate.
"""

from __future__ import annotations

import html
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from occupancy import DETROIT, SLOT_END, Meeting, Place, match_building

DEMO_PATH = Path(__file__).resolve().parent / "data" / "fall-2026-events.json"
WEEK_URL = "https://events.umich.edu/week/2026-10-05/json?v=2"
WEEK_START = date(2026, 10, 5)
WEEK_END = date(2026, 10, 11)

# Happening @ Michigan does not publish attendance. These are crowd sizes
# used only for the map.
EVENT_SEATS = {
    "Workshop / Seminar": 30,
    "Exhibition": 40,
    "Performance": 200,
    "Lecture / Discussion": 80,
    "Social / Informal Gathering": 50,
    "Film Screening": 80,
    "Sporting Event": 500,
    "Careers / Jobs": 40,
    "Conference / Symposium": 150,
    "Reception / Open House": 60,
    "Presentation": 40,
    "Well-being": 25,
    "Exercise / Fitness": 30,
    "Community Service": 20,
    "Fair / Festival": 150,
    "Other": 30,
}
DEFAULT_SEATS = 30
MAX_SEATS = 2000

# Rooms the feed names, mapped to the building we already have coordinates for.
_ALIASES = {
    "lydia mendelssohn": "LEAG",
    "betsey barbour": "BARB",
    "betsy barbour": "BARB",
}

_NAME_STOP = {
    "the", "of", "and", "for", "building", "center", "centre", "university",
    "michigan", "campus", "room", "off", "location", "u-m", "um",
}


def seats_for_type(event_type: str) -> int:
    return min(MAX_SEATS, EVENT_SEATS.get(event_type, DEFAULT_SEATS))


def clock_minutes(value: str) -> int | None:
    match = re.match(r"(\d{1,2}):(\d{2})", (value or "").strip())
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return hour * 60 + minute


def event_span(start_text: str, end_text: str, has_end: bool) -> tuple[int, int] | None:
    start = clock_minutes(start_text)
    if start is None:
        return None
    end = clock_minutes(end_text) if has_end else None
    if end is None:
        end = start + 90
    elif end <= start:
        end = SLOT_END
    # All-day listings would paint every hour. Keep them in typical open hours.
    if end - start >= 10 * 60:
        start = max(start, 10 * 60)
        end = min(end, 17 * 60)
    if end <= start:
        return None
    return start, min(end, SLOT_END)


def match_event_place(text: str, places: dict[str, Place]) -> str | None:
    raw = html.unescape(text or "").replace("&amp;", "and")
    if not raw.strip():
        return None
    lowered = raw.lower()
    if any(word in lowered for word in ("zoom", "virtual", "online", "livestream")):
        return None
    for needle, place_code in _ALIASES.items():
        if needle in lowered and place_code in places:
            return place_code
    code = match_building(raw, list(places))
    if code and code in places:
        return code
    tokens = _name_tokens(raw)
    if not tokens:
        return None
    best_code: str | None = None
    best_score = 0
    for place_code, place in places.items():
        name_tokens = _name_tokens(place.name)
        if not name_tokens:
            continue
        overlap = tokens & name_tokens
        if not overlap:
            continue
        distinctive = [word for word in overlap if len(word) >= 4]
        if not distinctive:
            continue
        score = len(distinctive) * 10 + len(overlap)
        if tokens <= name_tokens or name_tokens <= tokens:
            score += 5
        if score > best_score:
            best_score = score
            best_code = place_code
    return best_code


def placed_rows(feed: list[dict[str, Any]], places: dict[str, Place]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in feed:
        if not isinstance(item, dict):
            continue
        location = _location_text(item)
        building = match_event_place(location, places)
        if not building:
            continue
        span = event_span(
            str(item.get("time_start") or ""),
            str(item.get("time_end") or ""),
            str(item.get("has_end_time") or "") not in {"0", "false", "False"},
        )
        if span is None:
            continue
        try:
            first = date.fromisoformat(str(item.get("date_start")))
            last = date.fromisoformat(str(item.get("date_end") or item.get("date_start")))
        except ValueError:
            continue
        if last < first:
            last = first
        day = max(first, WEEK_START)
        stop = min(last, WEEK_END)
        event_type = str(item.get("event_type") or "Other")
        title = str(item.get("combined_title") or item.get("event_title") or "Campus event")
        while day <= stop:
            rows.append({
                "building": building,
                "date": day.isoformat(),
                "start": span[0],
                "end": span[1],
                "seats": seats_for_type(event_type),
                "title": title,
                "type": event_type,
            })
            day += timedelta(days=1)
    return rows


def meetings_from_snapshot(raw: dict[str, Any]) -> list[Meeting]:
    meetings: list[Meeting] = []
    for row in raw.get("events") or []:
        if not isinstance(row, dict):
            continue
        try:
            when = date.fromisoformat(str(row.get("date")))
            start, end = int(row["start"]), int(row["end"])
            seats = int(row["seats"])
        except (TypeError, ValueError):
            continue
        if end <= start or seats <= 0:
            continue
        meetings.append(Meeting(
            building=str(row.get("building") or ""),
            days=frozenset({when.weekday()}),
            start=start,
            end=end,
            seats=seats,
            class_number=str(row.get("title") or ""),
            combined="",
        ))
    return meetings


def load_demo_events() -> tuple[list[Meeting], str]:
    if not DEMO_PATH.exists():
        return [], ""
    try:
        raw = json.loads(DEMO_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return [], ""
    week = str(raw.get("week_of") or WEEK_START.isoformat())
    label = f"Happening @ Michigan, week of {week}"
    return meetings_from_snapshot(raw), label


def snapshot_payload(feed: list[dict[str, Any]], places: dict[str, Place]) -> dict[str, Any]:
    rows = placed_rows(feed, places)
    return {
        "version": 1,
        "source": "happening",
        "source_label": "Happening @ Michigan",
        "source_url": "https://events.umich.edu",
        "week_of": WEEK_START.isoformat(),
        "fetched_at": datetime.now(DETROIT).isoformat(),
        "note": "Attendance is estimated from the event type. The feed does not publish a headcount.",
        "events": rows,
    }


def _location_text(item: dict[str, Any]) -> str:
    building = str(item.get("building_name") or "").strip()
    location = str(item.get("location_name") or "").strip()
    if building and building.lower() not in {"off campus location", "virtual participation"}:
        return building
    return location or building


def _name_tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", html.unescape(text).lower())
    return {word for word in words if word not in _NAME_STOP and len(word) > 2}
