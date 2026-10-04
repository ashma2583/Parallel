"""
Where students are during the class day.

The Schedule of Classes API (https://gw.api.it.umich.edu/um/Curriculum/SOC)
supplies each section's enrollment capacity, days, and meeting place. The
registrar CSV is the same schedule when an API key is not configured. Building
coordinates come from the public campus map.

A person counts as present only while their section is meeting:
    seats = capacity, or enrollment when the section is over capacity
    present = round(seats * turnup)
"""

from __future__ import annotations

import asyncio
import csv
import html
import io
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from urllib.parse import quote
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

log = logging.getLogger("parallel.occupancy")

DETROIT = ZoneInfo("America/Detroit")
SOC_ROOT = "https://gw.api.it.umich.edu/um/Curriculum/SOC"
TOKEN_URL = "https://gw.api.it.umich.edu/um/oauth2/token"
BUILDINGS_URL = "https://apibuilder.studentlife.umich.edu/api/1/type/building?limit=-1"
ABBREV_URL = "https://ro.umich.edu/calendars/schedule-classes/location-abbreviations"
CSV_URL = "https://ro.umich.edu/system/files/timesched/pdf/{stem}.csv"
CACHE_PATH = Path(__file__).resolve().parent / "data" / "class-schedule.json"
DEMO_SCHEDULE_PATH = Path(__file__).resolve().parent / "data" / "fall-2026-class-load.json"
CACHE_VERSION = 1
CACHE_HOURS = 6

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
SLOT_START = 8 * 60
SLOT_END = 22 * 60
SLOT_STEP = 30

# Registrar codes that share a coordinate with a simulation node.
NODE_BY_CODE = {
    "AH": "angell",
    "UGLI": "shapiro",
    "SHAPIRO": "shapiro",
    "UNION": "union",
    "R-BUS": "ross",
    "MARKLEY": "markley",
    "SQ": "south_quad",
    "DC": "duderstadt",
    "BEYST": "beyster",
    "BEYSTER": "beyster",
    "GGBL": "gg_brown",
    "PIER": "pierpont",
    "BURS": "bursley",
    "NCRC": "ncrc",
    "UM HOSP": "uh",
    "MOTT": "mott",
}

# Pins already drawn for those nodes. Class counts sit on the same point.
NODE_PLACES = {
    "angell": (-83.7394, 42.2769),
    "shapiro": (-83.737, 42.2755),
    "union": (-83.7416, 42.2752),
    "ross": (-83.7383, 42.2709),
    "markley": (-83.7298, 42.2807),
    "south_quad": (-83.7368, 42.2736),
    "duderstadt": (-83.7156, 42.2911),
    "beyster": (-83.7161, 42.2927),
    "gg_brown": (-83.7138, 42.2933),
    "pierpont": (-83.7178, 42.2914),
    "bursley": (-83.7202, 42.2948),
    "ncrc": (-83.6925, 42.3052),
    "uh": (-83.7286, 42.2836),
    "mott": (-83.7262, 42.2827),
}

CODE_ALIASES = {
    "SHAPIRO": "UGLI",
    "BEYSTER": "BEYST",
    "UGL": "UGLI",
}

SKIP_LOCATION = {"", "TBA", "ARR", "ONLINE", "REMOTE", "WEB", "VIRTUAL", "N/A", "NA", "TBD", "NULL", "NONE"}
NAME_STOP = {"BUILDING", "HALL", "THE", "AND", "OF", "CENTER", "SCHOOL", "BLDG", "CAMPUS", "NORTH", "SOUTH"}

_lock = asyncio.Lock()
_schedule: dict[str, Any] | None = None


class ScheduleError(RuntimeError):
    """The schedule could not be read from the API or the registrar CSV."""


@dataclass(frozen=True)
class Meeting:
    building: str
    days: frozenset[int]
    start: int
    end: int
    seats: int
    class_number: str
    combined: str


@dataclass(frozen=True)
class Place:
    code: str
    name: str
    campus: str
    lat: float | None
    lng: float | None
    node_id: str | None


def detroit_now() -> datetime:
    return datetime.now(DETROIT)


def current_term(now: datetime) -> tuple[str, str, str]:
    """Term code, registrar file stem, and label.

    Fall 2026 is term 2610, matching the registrar's strm=2610 link.
    Winter of calendar year Y is ((Y - 1) % 100) * 100 + 70 (Winter 2026 = 2570).
    """
    override = os.getenv("UM_TERM", "").strip()
    year, month, day = now.year, now.month, now.day
    if month > 8 or (month == 8 and day >= 25):
        code, stem, label = f"{year % 100:02d}10", f"FA{year}", f"Fall {year}"
    elif month < 5:
        code, stem, label = f"{(year - 1) % 100:02d}70", f"WN{year}", f"Winter {year}"
    elif month == 5:
        code, stem, label = f"{(year - 1) % 100:02d}80", f"SP{year}", f"Spring {year}"
    elif month == 6:
        code, stem, label = f"{(year - 1) % 100:02d}90", f"SS{year}", f"Spring/Summer {year}"
    else:
        code, stem, label = f"{year % 100:02d}00", f"SU{year}", f"Summer {year}"
    return (override or code), stem, label


def parse_weekday(value: str | None) -> int | None:
    if value is None or not str(value).strip():
        return None
    key = str(value).strip().lower()[:3]
    table = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
    if key not in table:
        raise ValueError("weekday must be Mon, Tue, Wed, Thu, Fri, Sat, or Sun")
    return table[key]


def parse_days(text: str) -> frozenset[int]:
    """API days look like TuTh. Registrar days look like TTH or MWF."""
    raw = (text or "").strip()
    if not raw or raw.upper() in SKIP_LOCATION:
        return frozenset()
    compact = re.sub(r"[^A-Z]", "", raw.upper())
    days: set[int] = set()
    index = 0
    while index < len(compact):
        pair = compact[index : index + 2]
        if pair in {"TH", "TU", "SA", "SU", "MO", "WE", "FR"}:
            days.add({"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}[pair])
            index += 2
            continue
        letter = compact[index]
        single = {"M": 0, "T": 1, "W": 2, "H": 3, "F": 4, "S": 5}
        if letter in single:
            days.add(single[letter])
        index += 1
    return frozenset(days)


def _clock(token: str) -> int | None:
    token = token.strip().upper().replace(".", "").replace(" ", "")
    match = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?(AM|PM)?", token)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2) or 0)
        suffix = match.group(3)
        if suffix == "PM" and hour < 12:
            hour += 12
        if suffix == "AM" and hour == 12:
            hour = 0
        if hour > 23 or minute > 59:
            return None
        return hour * 60 + minute
    match = re.fullmatch(r"(\d{3,4})", token)
    if not match:
        return None
    hour, minute = divmod(int(match.group(1)), 100)
    if hour > 23 or minute > 59:
        return None
    return hour * 60 + minute


def parse_span(text: str) -> tuple[int, int] | None:
    raw = (text or "").strip()
    if not raw or "TBA" in raw.upper():
        return None
    parts = re.split(r"\s*[-–—]\s*", raw)
    if len(parts) != 2:
        return None
    start_raw, end_raw = parts
    start_suffix = _suffix(start_raw)
    end_suffix = _suffix(end_raw)
    if start_suffix is None and end_suffix:
        start_raw = f"{start_raw}{end_suffix}"
    start = _clock(start_raw)
    end = _clock(end_raw)
    if start is None or end is None:
        return None
    if start_suffix is None and end_suffix == "PM" and start >= end:
        start -= 12 * 60
    if start < 0 or end <= start:
        return None
    return start, end


def _suffix(token: str) -> str | None:
    found = re.search(r"(AM|PM)\s*$", token.strip(), re.IGNORECASE)
    return found.group(1).upper() if found else None


def seats_for(capacity: int, enrolled: int) -> int:
    seats = capacity if capacity > 0 else enrolled
    if enrolled > seats:
        seats = enrolled
    return max(0, seats)


def present(seats: int, turnup: float) -> int:
    if seats <= 0 or turnup <= 0:
        return 0
    return int(round(seats * turnup))


def match_building(location: str, codes: list[str]) -> str | None:
    """Longest known building code in a meeting location such as 'AH 1401' or '3302 MH'."""
    text = re.sub(r"\s+", " ", (location or "").upper()).strip()
    if text in SKIP_LOCATION or "ONLINE" in text or text.startswith("ARR"):
        return None
    codes = sorted({_canon(code) for code in codes if _canon(code)}, key=len, reverse=True)
    padded = f" {text} "
    for code in codes:
        if f" {code} " in padded:
            return code
        start = text.find(code)
        while start >= 0:
            before = text[start - 1] if start else ""
            after = text[start + len(code) : start + len(code) + 1]
            if (start == 0 or not before.isalnum()) and (after == "" or not after.isalpha()):
                return code
            start = text.find(code, start + 1)
    return None


def slot_minutes() -> list[int]:
    return list(range(SLOT_START, SLOT_END + 1, SLOT_STEP))


def clock_label(minutes: int) -> str:
    hour, minute = divmod(minutes, 60)
    suffix = "AM" if hour < 12 else "PM"
    hour12 = hour % 12 or 12
    return f"{hour12}:{minute:02d} {suffix}"


def project(
    meetings: list[Meeting],
    places: dict[str, Place],
    weekday: int,
    turnup: float,
    now: datetime,
    assumed: bool = False,
    events: list[Meeting] | None = None,
) -> dict[str, Any]:
    slots = slot_minutes()
    totals = [0 for _ in slots]
    event_totals = [0 for _ in slots]
    by_building: dict[str, list[int]] = {}
    active: list[tuple[Meeting, int]] = []
    event_count = 0
    for meeting, rate, kind in (
        *((meeting, turnup, "class") for meeting in meetings),
        *((meeting, 1.0, "event") for meeting in (events or [])),
    ):
        if weekday not in meeting.days:
            continue
        count = present(meeting.seats, rate)
        if count <= 0:
            continue
        if kind == "event":
            event_count += 1
        else:
            active.append((meeting, count))
        series = by_building.setdefault(meeting.building, [0 for _ in slots])
        for index, minute in enumerate(slots):
            if meeting.start <= minute < meeting.end:
                series[index] += count
                totals[index] += count
                if kind == "event":
                    event_totals[index] += count

    buildings = []
    for code, series in by_building.items():
        if sum(series) <= 0:
            continue
        place = places.get(code)
        node_id = place.node_id if place else NODE_BY_CODE.get(code)
        lng, lat = (None, None)
        if node_id and node_id in NODE_PLACES:
            lng, lat = NODE_PLACES[node_id]
        elif place and place.lat is not None and place.lng is not None:
            lng, lat = place.lng, place.lat
        buildings.append({
            "code": code,
            "name": place.name if place else code,
            "campus": place.campus if place else "",
            "lat": lat,
            "lng": lng,
            "node_id": node_id,
            "students": series,
        })
    buildings.sort(key=lambda row: max(row["students"]), reverse=True)

    focus, note = _focus(totals, weekday, now, assumed)
    return {
        "weekday": WEEKDAYS[weekday],
        "turnup": turnup,
        "focus": focus,
        "note": note,
        "slots": [
            {
                "minutes": minute,
                "label": clock_label(minute),
                "students": totals[index],
                "events": event_totals[index],
            }
            for index, minute in enumerate(slots)
        ],
        "buildings": buildings,
        "meeting_count": len(active),
        "event_count": event_count,
    }


def _focus(totals: list[int], weekday: int, now: datetime, assumed: bool) -> tuple[int, str | None]:
    minutes = now.hour * 60 + now.minute
    nearest = min(range(len(totals)), key=lambda index: abs(slot_minutes()[index] - minutes))
    peak = max(range(len(totals)), key=lambda index: totals[index])
    clock_day = now.weekday()
    if sum(totals) == 0:
        return nearest, f"No classes on the {WEEKDAYS[weekday]} schedule."
    if weekday == clock_day and totals[nearest] > 0:
        return nearest, None
    if weekday == clock_day:
        return peak, f"No classes at {clock_label(minutes)}. Showing {clock_label(slot_minutes()[peak])}, the busiest time today."
    if assumed:
        return peak, f"No classes on {WEEKDAYS[clock_day]}. Showing {WEEKDAYS[weekday]} {clock_label(slot_minutes()[peak])}."
    return peak, None


def choose_weekday(meetings: list[Meeting], requested: int | None, now: datetime) -> int:
    if requested is not None:
        return requested
    today = now.weekday()
    if any(today in meeting.days for meeting in meetings):
        return today
    for offset in range(1, 7):
        day = (today + offset) % 7
        if any(day in meeting.days for meeting in meetings):
            return day
    return today


async def snapshot(weekday: str | None = None, turnup: float = 0.75) -> dict[str, Any]:
    if turnup < 0 or turnup > 1:
        raise ValueError("turnup must be between 0 and 1")
    requested = parse_weekday(weekday)
    schedule = await load_schedule()
    now = detroit_now()
    day = choose_weekday(schedule["meetings"], requested, now)
    assumed = requested is None and day != now.weekday()
    from events import load_demo_events

    event_meetings, event_label = load_demo_events()
    body = project(schedule["meetings"], schedule["places"], day, turnup, now, assumed, event_meetings)
    body["term"] = schedule["term"]
    body["term_name"] = schedule["term_name"]
    body["source"] = schedule["source"]
    body["source_label"] = schedule["source_label"]
    if event_label:
        body["source_label"] = f"{schedule['source_label']} and {event_label}"
    return body


def _cache_mtime() -> float | None:
    try:
        return CACHE_PATH.stat().st_mtime
    except OSError:
        return None


async def load_schedule() -> dict[str, Any]:
    global _schedule
    async with _lock:
        mtime = _cache_mtime()
        if _schedule is not None and _fresh(_schedule) and _schedule.get("_mtime") == mtime:
            return _schedule
        cached = _read_cache()
        if cached is not None and _fresh(cached):
            cached["_mtime"] = mtime
            _schedule = cached
            return cached
        # The committed snapshot is the demo. Do not start a live download while it is present.
        snapshot = _read_snapshot()
        if snapshot is not None:
            _schedule = snapshot
            return snapshot
        try:
            loaded = await _fetch_schedule()
        except httpx.HTTPError as exc:
            fallback = cached or _read_snapshot()
            if fallback is not None:
                log.warning("schedule refresh failed; using a saved copy")
                _schedule = fallback
                return fallback
            raise ScheduleError("Could not reach the U-M schedule or campus map.") from exc
        except ScheduleError:
            fallback = cached or _read_snapshot()
            if fallback is not None:
                log.warning("schedule refresh failed; using a saved copy")
                _schedule = fallback
                return fallback
            raise
        _write_cache(loaded)
        hydrated = _hydrate(loaded)
        hydrated["_mtime"] = _cache_mtime()
        _schedule = hydrated
        return _schedule


def _fresh(schedule: dict[str, Any]) -> bool:
    fetched = schedule.get("fetched_at")
    if not isinstance(fetched, str):
        return False
    try:
        stamp = datetime.fromisoformat(fetched)
    except ValueError:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=DETROIT)
    age = detroit_now() - stamp
    return age.total_seconds() < CACHE_HOURS * 3600


async def _fetch_schedule() -> dict[str, Any]:
    now = detroit_now()
    term, stem, label = current_term(now)
    places = await _load_places()
    codes = sorted(places, key=len, reverse=True)
    errors: list[str] = []
    meetings: list[Meeting] | None = None
    source = ""
    source_label = ""

    csv_spec = os.getenv("SOC_CSV", "").strip()
    if csv_spec:
        try:
            text = await _read_csv_source(csv_spec)
            meetings = meetings_from_csv(text, codes)
            source, source_label = "registrar-csv", "Registrar schedule CSV"
        except ScheduleError as exc:
            errors.append(str(exc))

    if meetings is None and os.getenv("UM_CLIENT_ID", "").strip() and os.getenv("UM_CLIENT_SECRET", "").strip():
        try:
            meetings = await _meetings_from_api(term, codes)
            source, source_label = "um-api", "U-M Schedule of Classes API"
        except ScheduleError as exc:
            errors.append(str(exc))

    if meetings is None and not csv_spec:
        try:
            text = await _read_csv_source(CSV_URL.format(stem=stem))
            meetings = meetings_from_csv(text, codes)
            source, source_label = "registrar-csv", "Registrar schedule CSV"
        except ScheduleError as exc:
            errors.append(str(exc))

    if not meetings:
        hint = " ".join(errors)
        raise ScheduleError(
            "Set UM_CLIENT_ID and UM_CLIENT_SECRET for the Schedule of Classes API, or SOC_CSV to a registrar CSV. "
            + hint
        )
    log.info("class schedule: %s meetings from %s (%s)", len(meetings), source_label, term)
    return {
        "version": CACHE_VERSION,
        "fetched_at": now.isoformat(),
        "term": term,
        "term_name": label,
        "source": source,
        "source_label": source_label,
        "meetings": [_meeting_dict(item) for item in meetings],
        "places": {code: _place_dict(place) for code, place in places.items()},
    }


def _meeting_dict(meeting: Meeting) -> dict[str, Any]:
    return {
        "building": meeting.building,
        "days": sorted(meeting.days),
        "start": meeting.start,
        "end": meeting.end,
        "seats": meeting.seats,
        "class_number": meeting.class_number,
        "combined": meeting.combined,
    }


def _place_dict(place: Place) -> dict[str, Any]:
    return {
        "code": place.code,
        "name": place.name,
        "campus": place.campus,
        "lat": place.lat,
        "lng": place.lng,
        "node_id": place.node_id,
    }


def _hydrate(raw: dict[str, Any]) -> dict[str, Any]:
    meetings = [
        Meeting(
            building=item["building"],
            days=frozenset(item["days"]),
            start=int(item["start"]),
            end=int(item["end"]),
            seats=int(item["seats"]),
            class_number=str(item.get("class_number") or ""),
            combined=str(item.get("combined") or ""),
        )
        for item in raw.get("meetings") or []
    ]
    places = {}
    for code, item in (raw.get("places") or {}).items():
        places[code] = Place(
            code=item["code"],
            name=item["name"],
            campus=item.get("campus") or "",
            lat=item.get("lat"),
            lng=item.get("lng"),
            node_id=item.get("node_id"),
        )
    return {**raw, "meetings": meetings, "places": places}


def _read_cache() -> dict[str, Any] | None:
    return _read_schedule_file(CACHE_PATH)


def _read_snapshot() -> dict[str, Any] | None:
    return _read_schedule_file(DEMO_SCHEDULE_PATH)


def _read_schedule_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if raw.get("version") != CACHE_VERSION:
        return None
    return _hydrate(raw)


def _write_cache(schedule: dict[str, Any]) -> None:
    payload = {
        **schedule,
        "meetings": [_meeting_dict(item) if isinstance(item, Meeting) else item for item in schedule["meetings"]],
        "places": {
            code: _place_dict(place) if isinstance(place, Place) else place
            for code, place in schedule["places"].items()
        },
    }
    payload.pop("_mtime", None)
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = CACHE_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload))
    temporary.replace(CACHE_PATH)


async def _read_csv_source(spec: str) -> str:
    path = Path(spec)
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    if not spec.startswith("http"):
        raise ScheduleError(f"SOC_CSV is not a file or URL: {spec}")
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        response = await client.get(spec, headers={"User-Agent": "PARALLEL/occupancy"})
    if response.status_code >= 400 or "text/html" in response.headers.get("content-type", ""):
        raise ScheduleError("The registrar CSV is behind a login page right now.")
    if "<html" in response.text[:200].lower():
        raise ScheduleError("The registrar CSV is behind a login page right now.")
    return response.text


def meetings_from_csv(text: str, codes: list[str]) -> list[Meeting]:
    sample = text.lstrip("\ufeff")
    if not sample.strip() or sample.lstrip().lower().startswith("<!doctype") or sample.lstrip().lower().startswith("<html"):
        raise ScheduleError("The registrar file was not a CSV.")
    reader = csv.DictReader(io.StringIO(sample))
    if not reader.fieldnames:
        raise ScheduleError("The registrar CSV has no header row.")
    columns = {_norm_header(name): name for name in reader.fieldnames if name}

    def column(*names: str) -> str | None:
        for name in names:
            if name in columns:
                return columns[name]
        return None

    days_col = column("days", "day", "meets")
    time_col = column("time", "times", "classtime", "meetingtime")
    start_col = column("starttime", "mtgstart", "timestart")
    end_col = column("endtime", "mtgend", "timeend")
    location_col = column("location", "loc", "facility", "mtglocation", "facilitydescr")
    building_col = column("building", "bldg", "buildingcode", "bldgdescr")
    capacity_col = column("enrlcap", "enrollmentcapacity", "enrollmentcap", "classcapacity", "capenrl")
    enrolled_col = column("enrltot", "enrollmenttotal", "enrollmenttot", "enrolled")
    mode_col = column("mode", "instructionmode")
    class_col = column("classnbr", "classnumber")
    combined_col = column("combinedsection", "combinedsectionid")
    if not days_col or not (time_col or (start_col and end_col)):
        raise ScheduleError("The registrar CSV is missing days or meeting times.")
    if not capacity_col and not enrolled_col:
        raise ScheduleError("The registrar CSV is missing enrollment capacity.")
    if not location_col and not building_col:
        raise ScheduleError("The registrar CSV is missing a building or location column.")

    found: list[Meeting] = []
    for row in reader:
        mode = (row.get(mode_col) or "") if mode_col else ""
        if _remote(mode):
            continue
        if time_col:
            span = parse_span(row.get(time_col) or "")
        else:
            span = parse_span(f"{row.get(start_col) or ''} - {row.get(end_col) or ''}")
        days = parse_days(row.get(days_col) or "")
        if span is None or not days:
            continue
        location = (row.get(location_col) or "") if location_col else ""
        if not location and building_col:
            location = row.get(building_col) or ""
        building = match_building(location, codes)
        if not building:
            continue
        seats = seats_for(_number(row.get(capacity_col) if capacity_col else 0), _number(row.get(enrolled_col) if enrolled_col else 0))
        if seats <= 0:
            continue
        found.append(Meeting(
            building=building,
            days=days,
            start=span[0],
            end=span[1],
            seats=seats,
            class_number=str(row.get(class_col) or "") if class_col else "",
            combined=str(row.get(combined_col) or "").strip() if combined_col else "",
        ))
    if not found:
        raise ScheduleError("The registrar CSV had no placed class meetings.")
    return _dedupe(found)


def _norm_header(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _number(value: Any) -> int:
    text = str(value or "").strip().replace(",", "")
    if not text or text in {"-", "NA", "N/A"}:
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def _remote(mode: str) -> bool:
    text = mode.lower()
    if "hybrid" in text or "in person" in text or "in-person" in text:
        return False
    return "online" in text or "remote" in text


def _dedupe(meetings: list[Meeting]) -> list[Meeting]:
    best: dict[tuple, Meeting] = {}
    for meeting in meetings:
        if meeting.combined:
            key = ("c", meeting.combined, meeting.building, meeting.start, meeting.end, tuple(sorted(meeting.days)))
        else:
            key = ("n", meeting.class_number, meeting.building, meeting.start, meeting.end, tuple(sorted(meeting.days)))
        previous = best.get(key)
        if previous is None or meeting.seats > previous.seats:
            best[key] = meeting
    return list(best.values())


class _Gate:
    """Holds the API token and keeps requests under the gateway rate limit."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        client_id: str,
        client_secret: str,
        token: str,
        interval: float = 0.2,
    ) -> None:
        self.client = client
        self.client_id = client_id
        self.client_secret = client_secret
        self.token = token
        self.interval = interval
        self._lock = asyncio.Lock()
        self._pace = asyncio.Lock()
        self._next = 0.0

    async def refresh(self) -> None:
        async with self._lock:
            self.token = await _token(self.client, self.client_id, self.client_secret)

    async def slot(self) -> None:
        while True:
            async with self._pace:
                now = asyncio.get_running_loop().time()
                wait = self._next - now
                if wait <= 0:
                    self._next = now + self.interval
                    return
            await asyncio.sleep(wait)

    async def penalize(self, seconds: float) -> None:
        async with self._pace:
            now = asyncio.get_running_loop().time()
            self._next = max(self._next, now + seconds)


async def _meetings_from_api(term: str, codes: list[str]) -> list[Meeting]:
    client_id = os.getenv("UM_CLIENT_ID", "").strip()
    client_secret = os.getenv("UM_CLIENT_SECRET", "").strip()
    async with httpx.AsyncClient(timeout=40) as client:
        token = await _token(client, client_id, client_secret)
        gate = _Gate(client, client_id, client_secret, token)
        pairs = await _course_pairs(gate, term)
        if not pairs:
            raise ScheduleError(f"Schedule of Classes returned no subjects for term {term}.")
        log.info("schedule API term %s: %s subjects", term, len(pairs))
        sections = await _all_sections(gate, term, pairs)
    meetings = meetings_from_sections(sections, codes)
    if not meetings:
        raise ScheduleError("Schedule of Classes returned sections, but none had a building and a meeting time.")
    return meetings


async def _token(client: httpx.AsyncClient, client_id: str, client_secret: str) -> str:
    response = await client.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "umscheduleofclasses",
        },
        headers={"Accept": "application/json"},
    )
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise ScheduleError("U-M API token endpoint did not return JSON.") from exc
    token = body.get("access_token") if isinstance(body, dict) else None
    if response.status_code >= 400 or not token:
        detail = ""
        if isinstance(body, dict):
            detail = str(body.get("error_description") or body.get("error") or "")
        raise ScheduleError(f"U-M API login failed. {detail}".strip())
    return str(token)


async def _course_pairs(gate: _Gate, term: str) -> list[tuple[str, str]]:
    """(school, subject) pairs. The API has no single UM subject list."""
    status, payload = await _get(gate, f"/Terms/{term}/Schools")
    if status >= 400 or payload is None:
        raise ScheduleError(f"Schedule of Classes schools request failed ({status}).")
    schools = _school_codes(payload)
    if not schools:
        raise ScheduleError(f"Schedule of Classes returned no schools for term {term}.")
    limit = asyncio.Semaphore(8)

    async def one(school: str) -> list[tuple[str, str]]:
        async with limit:
            status, payload = await _get(gate, f"/Terms/{term}/Schools/{quote(school, safe='')}/Subjects")
        if status >= 400 or payload is None:
            log.warning("subjects for %s returned %s", school, status)
            return []
        return [(school, subject) for subject in _subject_codes(payload)]

    groups = await asyncio.gather(*(one(school) for school in schools))
    return [pair for group in groups for pair in group]


def _school_codes(payload: Any) -> list[str]:
    found: list[str] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            value = obj.get("SchoolCode")
            if isinstance(value, str) and re.fullmatch(r"[A-Z0-9]{1,8}", value.strip()):
                found.append(value.strip())
            for child in obj.values():
                walk(child)
        elif isinstance(obj, list):
            for child in obj:
                walk(child)

    walk(payload)
    return list(dict.fromkeys(found))


def _subject_codes(payload: Any) -> list[str]:
    found: list[str] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for key in ("SubjectCode", "Subject"):
                value = obj.get(key)
                if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9]{1,7}", value.strip()):
                    found.append(value.strip())
                    break
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(payload)
    return list(dict.fromkeys(found))


async def _all_sections(
    gate: _Gate,
    term: str,
    pairs: list[tuple[str, str]],
) -> list[dict[str, Any]]:
    # Room names are not on the section list (they come back as TBA). Catalog
    # numbers, then each course's sections, then a meetings call for rooms.
    collected: list[dict[str, Any]] = []
    limit = asyncio.Semaphore(4)
    done = 0
    total = len(pairs)

    async def one_subject(school: str, subject: str) -> list[dict[str, Any]]:
        nonlocal done
        path = f"/Terms/{term}/Schools/{quote(school, safe='')}/Subjects/{quote(subject, safe='')}"
        async with limit:
            status, payload = await _get(gate, f"{path}/CatalogNbrs")
        done += 1
        if done % 40 == 0 or done == total:
            log.info("schedule catalogs %s/%s", done, total)
        if status >= 400 or payload is None:
            return []
        numbers = _catalog_numbers(payload)

        async def one_number(number: str) -> list[dict[str, Any]]:
            async with limit:
                status, payload = await _get(
                    gate,
                    f"{path}/CatalogNbrs/{quote(number, safe='')}/Sections?IncludeAllSections=Y",
                )
            if status >= 400 or payload is None:
                return []
            return _tag_sections(_find_sections(payload), school, subject, number)

        groups = await asyncio.gather(*(one_number(number) for number in numbers))
        rows: list[dict[str, Any]] = []
        for group in groups:
            rows.extend(group)
        return rows

    groups = await asyncio.gather(*(one_subject(school, subject) for school, subject in pairs))
    for group in groups:
        collected.extend(group)
    unresolved = [row for row in collected if _needs_room(row)]
    log.info("schedule sections %s, rooms still to look up %s", len(collected), len(unresolved))
    if unresolved:
        filled = await _fill_locations(gate, term, unresolved)
        located = {_section_key(row): row for row in filled}
        collected = [located.get(_section_key(row), row) for row in collected]
    return collected


def _needs_room(section: dict[str, Any]) -> bool:
    if _location_text(section):
        return False
    if _remote(str(section.get("InstructionMode") or "")):
        return False
    if seats_for(_number(section.get("EnrollmentCapacity")), _number(section.get("EnrollmentTotal"))) <= 0:
        return False
    for meeting in _as_list(section.get("Meeting") or section.get("Meetings")):
        if not isinstance(meeting, dict):
            continue
        days = parse_days(str(meeting.get("Days") or ""))
        span = parse_span(str(meeting.get("Times") or meeting.get("Time") or ""))
        if days and span is not None:
            return True
    return False


def _section_key(section: dict[str, Any]) -> tuple[str, str, str, str, str]:
    return (
        str(section.get("_school") or ""),
        str(section.get("_subject") or ""),
        str(section.get("_catalog") or ""),
        str(section.get("SectionNumber") or ""),
        str(section.get("ClassNumber") or ""),
    )


def _tag_sections(sections: list[dict[str, Any]], school: str, subject: str, catalog: str) -> list[dict[str, Any]]:
    tagged = []
    for section in sections:
        copy = dict(section)
        copy["_school"] = str(copy.get("Acad_Group") or school)
        copy["_subject"] = str(copy.get("SubjectCode") or subject)
        copy["_catalog"] = str(copy.get("CatalogNumber") or copy.get("CatalogNbr") or catalog)
        tagged.append(copy)
    return tagged


def _find_sections(payload: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            if "EnrollmentCapacity" in obj or ("ClassNumber" in obj and "Meeting" in obj):
                found.append(obj)
                return
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(payload)
    return found


def _catalog_numbers(payload: Any) -> list[str]:
    found: list[str] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            for key in ("CatalogNumber", "CatalogNbr"):
                value = obj.get(key)
                if value not in (None, ""):
                    found.append(str(value).strip())
                    return
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(payload)
    return list(dict.fromkeys(found))


def _location_text(section: dict[str, Any]) -> str:
    for meeting in _as_list(section.get("Meeting") or section.get("Meetings")):
        if not isinstance(meeting, dict):
            continue
        for key in ("Location", "ClassMtgTopic"):
            value = meeting.get(key)
            if isinstance(value, str) and value.strip().upper() not in SKIP_LOCATION:
                return value.strip()
    return ""


async def _fill_locations(
    gate: _Gate,
    term: str,
    sections: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    limit = asyncio.Semaphore(4)
    done = 0
    total = len(sections)

    async def one(section: dict[str, Any]) -> dict[str, Any]:
        nonlocal done
        school = section.get("_school") or ""
        subject = section.get("_subject") or ""
        catalog = section.get("_catalog") or ""
        number = section.get("SectionNumber") or ""
        if not school or not subject or not catalog or number in ("", None):
            return section
        path = (
            f"/Terms/{term}/Schools/{quote(str(school), safe='')}"
            f"/Subjects/{quote(str(subject), safe='')}"
            f"/CatalogNbrs/{quote(str(catalog), safe='')}"
            f"/Sections/{quote(str(number), safe='')}/Meetings"
        )
        async with limit:
            status, payload = await _get(gate, path)
        done += 1
        if done % 400 == 0 or done == total:
            log.info("schedule rooms %s/%s", done, total)
        if status >= 400 or not isinstance(payload, dict):
            return section
        meetings = _as_list(_dig_meetings(payload))
        if meetings:
            copy = dict(section)
            copy["Meeting"] = meetings
            return copy
        return section

    return await asyncio.gather(*(one(section) for section in sections))


def _dig_meetings(payload: dict[str, Any]) -> Any:
    for value in payload.values():
        if isinstance(value, dict) and "Meeting" in value:
            return value["Meeting"]
    return payload.get("Meeting")


async def _get(gate: _Gate, path: str) -> tuple[int, Any]:
    response: httpx.Response | None = None
    for attempt in range(8):
        await gate.slot()
        response = await gate.client.get(
            SOC_ROOT + path,
            headers={"Authorization": f"Bearer {gate.token}", "Accept": "application/json"},
        )
        if response.status_code == 401 and attempt < 7:
            await gate.refresh()
            continue
        if response.status_code in {429, 503} and attempt < 7:
            retry_after = response.headers.get("Retry-After")
            try:
                pause = float(retry_after) if retry_after else 0.0
            except ValueError:
                pause = 0.0
            pause = max(pause, min(2.0 * (attempt + 1), 15.0))
            await gate.penalize(pause)
            await asyncio.sleep(pause)
            continue
        if response.status_code >= 400:
            return response.status_code, None
        try:
            return response.status_code, response.json()
        except json.JSONDecodeError:
            return response.status_code, None
    log.warning("schedule request gave up after rate limits: %s", path)
    return (response.status_code if response is not None else 0), None


def meetings_from_sections(sections: list[dict[str, Any]], codes: list[str]) -> list[Meeting]:
    found: list[Meeting] = []
    for section in sections:
        if _remote(str(section.get("InstructionMode") or "")):
            continue
        seats = seats_for(_number(section.get("EnrollmentCapacity")), _number(section.get("EnrollmentTotal")))
        if seats <= 0:
            continue
        combined = str(section.get("CombinedSectionID") or "").strip()
        if combined.lower() in {"", "none", "null"}:
            combined = ""
        class_number = str(section.get("ClassNumber") or "")
        for meeting in _as_list(section.get("Meeting") or section.get("Meetings")):
            if not isinstance(meeting, dict):
                continue
            days = parse_days(str(meeting.get("Days") or ""))
            span = parse_span(str(meeting.get("Times") or meeting.get("Time") or ""))
            if not days or span is None:
                continue
            location = ""
            for key in ("Location", "ClassMtgTopic"):
                value = meeting.get(key)
                if isinstance(value, str) and value.strip().upper() not in SKIP_LOCATION:
                    location = value
                    break
            building = match_building(location, codes)
            if not building:
                continue
            found.append(Meeting(
                building=building,
                days=days,
                start=span[0],
                end=span[1],
                seats=seats,
                class_number=class_number,
                combined=combined,
            ))
    return _dedupe(found)


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


async def _load_places() -> dict[str, Place]:
    async with httpx.AsyncClient(timeout=40, follow_redirects=True) as client:
        buildings, abbrev = await asyncio.gather(
            client.get(BUILDINGS_URL, headers={"User-Agent": "PARALLEL/occupancy"}),
            client.get(ABBREV_URL, headers={"User-Agent": "Mozilla/5.0"}),
        )
    if buildings.status_code >= 400:
        raise ScheduleError("Campus building map could not be loaded.")
    try:
        pois = buildings.json().get("pois") or []
    except json.JSONDecodeError as exc:
        raise ScheduleError("Campus building map did not return JSON.") from exc
    official = {_canon(code): pair for code, pair in (_abbreviations(abbrev.text) if abbrev.status_code < 400 else {}).items()}
    places: dict[str, Place] = {}

    def keep(code: str, place: Place) -> None:
        code = _canon(code)
        if not code:
            return
        current = places.get(code)
        official_name = official.get(code, ("", ""))[0]
        if current is None or _prefer(place, current, official_name):
            places[code] = place

    for poi in pois:
        raw = poi.get("input") or {}
        acronym = _canon(str(raw.get("acronym") or ""))
        if not acronym:
            continue
        lat, lng = _coord(raw.get("lat")), _coord(raw.get("lng"))
        node_id = NODE_BY_CODE.get(acronym)
        keep(acronym, Place(
            code=acronym,
            name=str(raw.get("name") or official.get(acronym) or acronym),
            campus="",
            lat=lat,
            lng=lng,
            node_id=node_id,
        ))

    for code, (name, campus) in official.items():
        code = _canon(code)
        target = _canon(CODE_ALIASES.get(code, code))
        base = places.get(target) or places.get(code)
        node_id = NODE_BY_CODE.get(code) or NODE_BY_CODE.get(target) or (base.node_id if base else None)
        lat = base.lat if base else None
        lng = base.lng if base else None
        if lat is None:
            lat, lng = _match_name(name, pois)
        place = Place(code=code, name=name, campus=campus, lat=lat, lng=lng, node_id=node_id)
        keep(code, place)
        if target != code and target not in places and lat is not None:
            keep(target, Place(target, name, campus, lat, lng, node_id))
    if not places:
        raise ScheduleError("No campus buildings came back with a location.")
    return places


def _prefer(candidate: Place, current: Place, official_name: str) -> bool:
    if official_name and candidate.name.lower() == official_name.lower():
        return True
    if official_name and current.name.lower() == official_name.lower():
        return False
    if candidate.lat is None and current.lat is not None:
        return False
    return len(candidate.name) < len(current.name)


def _match_name(official: str, pois: list[dict[str, Any]]) -> tuple[float | None, float | None]:
    wanted = _words(official)
    best: tuple[int, float | None, float | None] = (0, None, None)
    for poi in pois:
        raw = poi.get("input") or {}
        score = len(wanted & _words(str(raw.get("name") or "")))
        if score > best[0] and score >= 1 and any(len(word) >= 5 for word in wanted & _words(str(raw.get("name") or ""))):
            best = (score, _coord(raw.get("lat")), _coord(raw.get("lng")))
    return best[1], best[2]


def _words(name: str) -> set[str]:
    return {word for word in re.findall(r"[A-Z0-9]+", name.upper()) if len(word) > 3 and word not in NAME_STOP}


def _abbreviations(page: str) -> dict[str, tuple[str, str]]:
    found: dict[str, tuple[str, str]] = {}
    for code, name, campus in re.findall(r"<strong>(.*?)</strong><br>(.*?)<br>(.*?)</p>", page, re.I):
        found[html.unescape(code).strip()] = (html.unescape(re.sub(r"<[^>]+>", "", name)).strip(), html.unescape(campus).strip())
    return found


def _canon(code: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(code).upper()).strip()


def _coord(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


# ---------------------------------------------------------------------------
# People drive the simulation
#
# At the campus clock's time of day, each simulation node that has a registrar
# code gets its occupancy from the schedule instead of a fixed number. The
# energy agent's "people" policy, the transit agent's evacuations, the briefing
# and Branch all read node.occupancy, so they all see who is really there.
# ---------------------------------------------------------------------------

# Staff and the people who are in a building whatever the class schedule says, as a share of its
# fixed headcount. Labs work through the day and libraries fill with people studying, not in a section.
STAFF_SHARE = {"academic": 0.08, "research": 0.35, "library": 0.2, "dining": 0.1, "dorm": 0.08}
STAFF_DEFAULT = 0.08
STAFF_MIN = 5
# At the busiest slot of the day this share of residents is out in class.
RESIDENTS_IN_CLASS = 0.4

# What the People tab has selected. None means the weekday of today's clock.
selection: dict[str, Any] = {"weekday": None, "turnup": 0.75}
_sim_cache: dict[tuple, dict[str, Any]] = {}
_weekday_cache: dict[tuple, int] = {}
_sim_schedule: dict[str, Any] | None = None
_sim_schedule_tried = 0.0


def drives_sim() -> bool:
    """PEOPLE_DRIVES_SIM=0 turns this off. Anything else, or unset, leaves it on."""
    return os.getenv("PEOPLE_DRIVES_SIM", "1").strip().lower() not in {"0", "false", "no", "off"}


def select(weekday: str | None = None, turnup: float | None = None) -> dict[str, Any]:
    """Record the People tab's weekday and turnup so the engine uses the same ones."""
    if turnup is not None:
        if turnup < 0 or turnup > 1:
            raise ValueError("turnup must be between 0 and 1")
        selection["turnup"] = float(turnup)
    if weekday is not None:
        selection["weekday"] = parse_weekday(weekday)
    day = selection["weekday"]
    return {"weekday": WEEKDAYS[day] if day is not None else None, "turnup": selection["turnup"]}


def schedule_now() -> dict[str, Any] | None:
    """The schedule without waiting on the network: the one in memory, else a saved copy from disk."""
    global _sim_schedule, _sim_schedule_tried
    if _schedule is not None:
        return _schedule
    if _sim_schedule is not None:
        return _sim_schedule
    # A missing file is retried every half minute, not every tick.
    stamp = time.monotonic()
    if stamp - _sim_schedule_tried < 30 and _sim_schedule_tried:
        return None
    _sim_schedule_tried = stamp
    cached = _read_cache()
    if cached is not None and _fresh(cached):
        _sim_schedule = cached
    else:
        _sim_schedule = _read_snapshot() or cached
    return _sim_schedule


def slot_at(minutes: int) -> int | None:
    """Index of the 30-minute slot holding this minute of the day, or None outside the class day."""
    if minutes < SLOT_START or minutes >= SLOT_END + SLOT_STEP:
        return None
    return (minutes - SLOT_START) // SLOT_STEP


def slot_label(weekday: int, slot: int | None, minutes: int) -> str:
    """Tue 14:00. Outside the class day it is the time itself."""
    when = SLOT_START + slot * SLOT_STEP if slot is not None else minutes
    return f"{WEEKDAYS[weekday]} {when // 60:02d}:{when % 60:02d}"


def sim_weekday(schedule: dict[str, Any], requested: int | None = None) -> int:
    """The People selection, else today, moving on to the next day with classes the way /occupancy does."""
    chosen = selection["weekday"] if requested is None else requested
    today = detroit_now()
    key = (id(schedule), chosen, today.date())
    if key not in _weekday_cache:
        _weekday_cache.clear()
        _weekday_cache[key] = choose_weekday(schedule["meetings"], chosen, today)
    return _weekday_cache[key]


def _node_for(code: str, places: dict[str, Place]) -> str | None:
    place = places.get(code)
    return (place.node_id if place and place.node_id else None) or NODE_BY_CODE.get(code)


def sim_series(schedule: dict[str, Any], weekday: int) -> dict[str, Any]:
    """Students in class per slot for each simulation node, and campus-wide. Cached per schedule, day, and turnup."""
    rate = selection["turnup"]
    key = (id(schedule), weekday, round(rate, 3))
    found = _sim_cache.get(key)
    if found is not None:
        return found
    from events import load_demo_events

    events, _ = load_demo_events()
    body = project(schedule["meetings"], schedule["places"], weekday, rate, detroit_now(), False, events)
    count = len(slot_minutes())
    by_node: dict[str, list[int]] = {}
    for row in body["buildings"]:
        node_id = row["node_id"]
        if not node_id:
            continue
        series = by_node.setdefault(node_id, [0] * count)
        for index, students in enumerate(row["students"]):
            series[index] += students
    # Nodes the registrar or the events ever put people in, on any day. The rest keep their baseline.
    known = {
        node
        for meeting in (*schedule["meetings"], *events)
        if (node := _node_for(meeting.building, schedule["places"]))
    }
    totals = [slot["students"] for slot in body["slots"]]
    found = {"by_node": by_node, "totals": totals, "peak": max(totals) if totals else 0, "known": known}
    if len(_sim_cache) > 24:
        _sim_cache.clear()
    _sim_cache[key] = found
    return found


def target_occupancy(node: Any, students: int, share_out: float) -> int:
    """People in one building in this slot, from its fixed headcount and the students in class there."""
    from graph import BASE_OCCUPANCY, NodeType

    fixed = BASE_OCCUPANCY.get(node.id, node.baseline_occupancy)
    floor = max(STAFF_MIN, round(fixed * STAFF_SHARE.get(node.type.value, STAFF_DEFAULT)))
    if node.type == NodeType.DORM:
        # Residents who are not out in class, plus anyone attending a class held in the hall.
        return max(floor, round(fixed * (1.0 - RESIDENTS_IN_CLASS * share_out))) + students
    return max(floor, students)


def apply_to_graph(graph: Any, minutes: int | None = None, weekday: int | None = None) -> bool:
    """
    Set each mapped building's occupancy from the schedule at this minute of the day.

    The baseline becomes the real count. A lit building's current headcount is
    scaled with it, so people the transit agent already moved in stay counted;
    a dark one keeps what transit left it. Hospitals are never touched. Cheap to
    call every tick: nothing changes until the 30-minute slot does. Returns True
    when it changed anything.
    """
    if not drives_sim():
        return False
    from graph import NodeType, Status

    schedule = schedule_now()
    if schedule is None:
        return False
    series = sim_series(schedule, sim_weekday(schedule, weekday))
    slot = slot_at(graph.sim_minutes() if minutes is None else minutes)
    share_out = (series["totals"][slot] / series["peak"]) if slot is not None and series["peak"] else 0.0
    changed = False
    for node_id in sorted(set(NODE_BY_CODE.values())):
        node = graph.nodes.get(node_id)
        if node is None or node.type in (NodeType.HOSPITAL, NodeType.SUBSTATION):
            continue
        if node_id not in series["known"] and node_id not in series["by_node"]:
            continue
        students = series["by_node"][node_id][slot] if slot is not None and node_id in series["by_node"] else 0
        target = target_occupancy(node, students, share_out)
        old = node.baseline_occupancy
        if target == old:
            continue
        node.baseline_occupancy = target
        changed = True
        if node.failed or node.status == Status.RED:
            continue
        node.occupancy = round(node.occupancy * target / old) if old > 0 else node.occupancy + target
    return changed


def people_now(graph: Any, weekday: int | None = None) -> dict[str, Any]:
    """Who is in class right now, by building, for the agents and the language model."""
    schedule = schedule_now()
    when = graph.sim_minutes()
    if schedule is None:
        return {"slot": None, "weekday": None, "minutes": when, "driving": drives_sim(), "total": 0, "buildings": []}
    day = sim_weekday(schedule, weekday)
    series = sim_series(schedule, day)
    slot = slot_at(when)
    rows = []
    for node_id in sorted(set(NODE_BY_CODE.values())):
        node = graph.nodes.get(node_id)
        if node is None:
            continue
        students = series["by_node"][node_id][slot] if slot is not None and node_id in series["by_node"] else 0
        rows.append({"node_id": node_id, "name": node.name, "students": students, "present": node.occupancy})
    rows.sort(key=lambda row: (-row["students"], row["name"]))
    return {
        "slot": slot_label(day, slot, when),
        "weekday": WEEKDAYS[day],
        "minutes": when,
        "turnup": selection["turnup"],
        "driving": drives_sim(),
        "total": sum(row["students"] for row in rows),
        "buildings": rows,
    }
