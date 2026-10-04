"""
Research a place the director wants to add.

The language model is good at knowing WHICH buildings matter on a campus and
bad at knowing where they are, so the work is split:

  1. One model call with web search names the 15-20 buildings that matter in
     an outage, their roles, and how the campus is powered.
  2. OpenStreetMap places them. Each building is matched to a real mapped
     feature; one that cannot be found is dropped rather than guessed.
  3. OpenStreetMap also supplies the real power plants and substations near
     the campus, so there is something to draw feeds from even when the model
     names none.
  4. Each building is put on its nearest power source. That assignment is an
     assumption and is labelled as one; which building is on which feeder is
     rarely published.

There is no load estimate.
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import math
import os
import re
from pathlib import Path
from typing import Any

import httpx

from voice import _strip_fence, _xai_key

log = logging.getLogger("parallel.location")

RESPONSES_URL = "https://api.x.ai/v1/responses"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# The public Overpass servers are often busy, so each is tried in turn.
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
# Both OpenStreetMap services ask every client to identify itself.
OSM_HEADERS = {"User-Agent": "PARALLEL campus twin (github.com/ashma2583/Parallel)"}

ROLES = {"power", "hospital", "housing", "academic", "research", "transit", "civic"}
MAX_BUILDINGS = 20
MAX_LINES = 8


CACHE_DIR = Path(__file__).resolve().parent / "data" / "locations"


def _cache_path(query: str) -> Path:
    return CACHE_DIR / f"{re.sub(r'[^a-z0-9]+', '-', query.strip().lower()).strip('-') or 'place'}.json"


async def research_location(query: str, refresh: bool = False) -> dict[str, Any]:
    """Saved research if there is any, otherwise a fresh pass that is then saved."""
    path = _cache_path(query)
    if not refresh and path.exists():
        try:
            return {**json.loads(path.read_text()), "cached": True}
        except (OSError, ValueError):
            pass
    found = await _research(query)
    # Only a result the map has checked is worth keeping.
    placement = found.get("placement", {})
    if placement.get("checked") and placement.get("power_checked") and any(b["role"] == "power" for b in found["buildings"]):
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(found, indent=1))
        except OSError as exc:
            log.warning("could not save research for %r: %s", query, exc)
    return found


async def _research(query: str) -> dict[str, Any]:
    key = _xai_key()
    if not key:
        raise RuntimeError("XAI_API_KEY is not set")
    model = os.getenv("GROK_RESEARCH_MODEL") or os.getenv("GROK_MODEL", "grok-4")
    prompt = (
        "You research one place for a campus emergency desk. Use web search.\n"
        "If the request is a campus, city, or district, return the 15 to 20 buildings "
        "that matter most when the power fails: the power plant or substation that serves it, "
        "every hospital with inpatient beds on or beside the campus, the three or four largest "
        "residence halls by number of residents, the main library, the student union, the largest "
        "classroom and research buildings, the police or public safety headquarters, and the transit hub. "
        "Do not spend entries on buildings that are merely famous.\n"
        "Use each building's official name as it appears on a map, one real building per entry. "
        "For a housing complex, name its main building.\n"
        "Be honest about roles. power means a physical power plant, cogeneration plant, or electrical "
        "substation, not a utilities office; if you cannot find one, return none and do not invent one. "
        "hospital means inpatient beds for people. A student health clinic or a veterinary hospital is civic. "
        "A student union, a recreation center and an administration building are civic, not academic. "
        "transit means a station or terminal where people board, not a parking or transportation office. "
        "Always include one hospital: the institution's own if it has one nearby, otherwise the nearest "
        "hospital with an emergency department, even though it is a separate institution. Say in why how far it is.\n"
        "If the request is a single building, return that building only, plus the core "
        "transit lines that stop there. Do not pad the list.\n"
        "Transit means the few lines that connect those buildings, not every route in the city.\n"
        "Give your best latitude and longitude for each building. They are only a hint: every building "
        "is checked against OpenStreetMap afterwards. Never give two buildings the same coordinates.\n"
        "Search at most twice, then answer. Do not invent electrical loads, ridership, or population counts.\n"
        "Reply with JSON only:\n"
        '{"name": str, "summary": str, '
        '"power": {"utility": str, "on_campus_plant": str, "how_it_is_fed": str}, '
        '"buildings": [{"name": str, "role": str, "why": str, "lat": number, "lng": number}], '
        '"transit": [{"name": str, "agency": str, "connects": str}]}\n'
        "role is one of: power, hospital, housing, academic, research, transit, civic.\n"
        "why is one sentence on why this building is in the set.\n"
        "power.on_campus_plant is the name of the campus's own plant, or an empty string if it has none. "
        "power.how_it_is_fed is one or two sentences on where the campus's electricity comes from.\n\n"
        f"Place: {query.strip()}"
    )
    body = await _complete(model, key, prompt)
    if body is None and model != "grok-4.7":
        body = await _complete("grok-4.7", key, prompt)
    if body is None:
        raise RuntimeError("location research failed")
    parsed = _json_object(body["content"])
    found = _clean(parsed, body.get("citations") or [])
    try:
        return await _ground(query, found)
    except Exception as exc:  # noqa: BLE001 - the map check must not lose the research
        log.warning("map check failed for %r: %s", query, exc)
        for building in found["buildings"]:
            building["located"] = "model"
        found["placement"] = {"checked": False, "note": "OpenStreetMap could not be reached, so positions are the model's own."}
        return found


async def _complete(model: str, key: str, prompt: str) -> dict[str, Any] | None:
    payload = {
        "model": model,
        "input": prompt,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 1800,
    }
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.post(RESPONSES_URL, headers={"Authorization": f"Bearer {key}"}, json=payload)
    if resp.status_code >= 400:
        return None
    data = resp.json()
    texts: list[str] = []
    citations: list[str] = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        for block in item.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("text"):
                texts.append(str(block["text"]))
            for note in block.get("annotations") or []:
                if isinstance(note, dict) and note.get("url"):
                    citations.append(str(note["url"]))
    for url in data.get("citations") or []:
        if isinstance(url, str):
            citations.append(url)
    content = "\n".join(texts).strip()
    if not content:
        return None
    return {"content": content, "citations": citations}


def _clean(parsed: dict[str, Any], citations: list[Any]) -> dict[str, Any]:
    buildings = []
    for raw in parsed.get("buildings") or []:
        if not isinstance(raw, dict):
            continue
        lat = _coord(raw.get("lat"), -90, 90)
        lng = _coord(raw.get("lng"), -180, 180)
        name = str(raw.get("name") or "").strip()
        if lat is None or lng is None or not name:
            continue
        role = str(raw.get("role") or "civic").strip().lower()
        buildings.append({
            "name": name,
            "role": role if role in ROLES else "civic",
            "why": str(raw.get("why") or "").strip(),
            "lat": lat,
            "lng": lng,
        })
        if len(buildings) == MAX_BUILDINGS:
            break

    transit = []
    for raw in parsed.get("transit") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        transit.append({
            "name": name,
            "agency": str(raw.get("agency") or "").strip(),
            "connects": str(raw.get("connects") or "").strip(),
        })
        if len(transit) == MAX_LINES:
            break

    sources = []
    for item in citations:
        url = item if isinstance(item, str) else str((item or {}).get("url") or "")
        url = url.strip()
        if url.startswith("http") and url not in sources:
            sources.append(url)
        if len(sources) == 6:
            break

    power = parsed.get("power") if isinstance(parsed.get("power"), dict) else {}
    return {
        "name": str(parsed.get("name") or "").strip(),
        "summary": str(parsed.get("summary") or "").strip(),
        "power": {key: str(power.get(key) or "").strip() for key in ("utility", "on_campus_plant", "how_it_is_fed")},
        "buildings": buildings,
        "transit": transit,
        "sources": sources,
    }


def _json_object(text: str) -> dict[str, Any]:
    raw = _strip_fence(text)
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start : end + 1]
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("location research did not return an object")
    return parsed


def _coord(value: Any, low: float, high: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < low or number > high:
        return None
    return number


# --------------------------------------------------------------------------- #
# Grounding: place the model's buildings on the real map
# --------------------------------------------------------------------------- #

# A building this far from the campus is too far to belong in one outage picture.
MAX_SPAN_KM = 6.0
# Below this similarity a name match is treated as a different building.
MATCH_FLOOR = 0.62
# Words that say what kind of place it is, not which one.
GENERIC = {
    "the", "of", "and", "for", "at", "hall", "halls", "building", "center", "centre", "complex", "facility",
    "university", "college", "school", "residence", "house", "station", "campus", "main",
}


def _meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    x = math.radians(lng2 - lng1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = math.radians(lat2 - lat1)
    return math.hypot(x, y) * 6_371_000


def _tokens(name: str) -> list[str]:
    words = re.sub(r"[^a-z0-9 ]+", " ", name.lower().replace("&", " and ")).split()
    return [w for w in words if w not in GENERIC] or words


def _similarity(a: str, b: str) -> float:
    """0..1. Shared distinctive words count most; spelling closeness breaks ties."""
    ta, tb = set(_tokens(a)), set(_tokens(b))
    if not ta or not tb:
        return 0.0
    overlap = len(ta & tb) / len(ta | tb)
    contained = 1.0 if ta <= tb or tb <= ta else 0.0
    spelling = difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    return max(overlap, 0.55 * spelling + 0.35 * contained + 0.1 * overlap)


async def _campus_box(client: httpx.AsyncClient, query: str, hints: list[dict[str, Any]]) -> dict[str, float] | None:
    """Where to look: the geocoder's outline of the place, widened to take in the model's hints."""
    resp = await client.get(NOMINATIM_URL, params={"q": query, "format": "jsonv2", "limit": 1})
    hit = (resp.json() or [None])[0] if resp.status_code == 200 else None
    if hit:
        south, north, west, east = (float(v) for v in hit["boundingbox"])
        lat, lng = float(hit["lat"]), float(hit["lon"])
    else:
        # The geocoder does not know the place. Fall back to where the model put things.
        distinct = {(round(b["lat"], 4), round(b["lng"], 4)) for b in hints}
        if not distinct:
            return None
        lat = sum(p[0] for p in distinct) / len(distinct)
        lng = sum(p[1] for p in distinct) / len(distinct)
        south = north = lat
        west = east = lng
    # The place's own outline, capped so a university with far-flung land does not become a county-wide search.
    half = 0.02
    box_core = {"core": (max(south, lat - half) - 0.003, max(west, lng - half * 1.4) - 0.004, min(north, lat + half) + 0.003, min(east, lng + half * 1.4) + 0.004)}
    # A campus spread through a city has a tiny outline, so let nearby hints stretch it.
    for b in hints:
        if _meters(lat, lng, b["lat"], b["lng"]) <= MAX_SPAN_KM * 1000:
            south, north = min(south, b["lat"]), max(north, b["lat"])
            west, east = min(west, b["lng"]), max(east, b["lng"])
    pad = 0.004
    return {**box_core, "south": south - pad, "west": west - pad, "north": north + pad, "east": east + pad, "lat": lat, "lng": lng}


async def _mapped_features(client: httpx.AsyncClient, box: dict[str, float], hints: list[tuple[float, float]]) -> list[dict[str, Any]]:
    """
    Every named building and every power site near the campus, in one request.

    The search covers the place's own outline plus a circle round each of the
    model's hints. A campus scattered through a city would otherwise need a box
    over the whole city, which the public servers refuse.
    """
    b = f"{box['core'][0]:.5f},{box['core'][1]:.5f},{box['core'][2]:.5f},{box['core'][3]:.5f}"
    areas = [f"({b})"] + [f"({_square(lat, lng, NEAR_HINT_M)})" for lat, lng in hints]
    named = "".join(
        f'nwr["building"]["name"]{area};'
        f'nwr["amenity"~"hospital|library|clinic|bus_station|fire_station|police|townhall"]["name"]{area};'
        f'nwr["railway"~"station|subway_entrance"]["name"]{area};'
        for area in areas
    )
    ql = (
        "[out:json][timeout:40];("
        f"{named}"
        ");out center tags;"
    )
    return await _overpass(client, ql)


async def _power_features(client: httpx.AsyncClient, lat: float, lng: float) -> list[dict[str, Any]]:
    """Plants and substations within reach of the campus, measured from the middle of its buildings."""
    reach = _square(lat, lng, 4500)
    return await _overpass(client, (
        "[out:json][timeout:25];("
        f'nwr["power"~"^(plant|substation)$"]({reach});'
        f'nwr["amenity"="hospital"]["name"]({reach});'
        ");out center tags;"
    ))


def _square(lat: float, lng: float, half_m: float) -> str:
    """south,west,north,east of a square this many metres from centre to edge."""
    dlat = half_m / 111_320
    dlng = half_m / (111_320 * max(0.2, math.cos(math.radians(lat))))
    return f"{lat - dlat:.5f},{lng - dlng:.5f},{lat + dlat:.5f},{lng + dlng:.5f}"


async def _overpass(client: httpx.AsyncClient, ql: str) -> list[dict[str, Any]]:
    elements = None
    for attempt in range(2):
        for url in OVERPASS_URLS:
            try:
                resp = await client.post(url, data={"data": ql})
                body = resp.json() if resp.status_code == 200 else {}
                # A server that runs out of time still answers 200, with a remark and no data.
                if resp.status_code == 200 and "remark" not in body:
                    elements = body.get("elements") or []
                    break
            except (httpx.HTTPError, ValueError):
                pass
        if elements is not None:
            break
        await asyncio.sleep(4)
    if elements is None:
        raise RuntimeError("every Overpass server refused or timed out")
    features = []
    for el in elements:
        tags = el.get("tags") or {}
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lng = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lng is None:
            continue
        names = [tags[k] for k in ("name", "official_name", "alt_name", "short_name", "old_name") if tags.get(k)]
        features.append({
            "names": [part.strip() for name in names for part in name.split(";")],
            "lat": float(lat), "lng": float(lng), "tags": tags, "osm": f"{el['type']}/{el['id']}",
        })
    return features


# A trustworthy hint keeps the search local: a same-named building across town is a different building.
NEAR_HINT_M = 700


def _best_match(name: str, features: list[dict[str, Any]], hint: tuple[float, float] | None, power: bool = False) -> dict[str, Any] | None:
    """The mapped feature this name refers to. Power sites only match power buildings, and the reverse."""
    scored = []
    for f in features:
        if bool(f["tags"].get("power")) != power:
            continue
        score = max((_similarity(name, n) for n in f["names"]), default=0.0)
        if score >= MATCH_FLOOR:
            away = _meters(hint[0], hint[1], f["lat"], f["lng"]) if hint else 0.0
            scored.append((score, away, f))
    if not scored:
        return None
    near = [item for item in scored if item[1] <= NEAR_HINT_M]
    pool = near or scored
    return max(pool, key=lambda item: (round(item[0], 2), -item[1]))[2]


# Words that mark a building as a real source of power or heat, as opposed to an office.
PLANT_WORDS = re.compile(r"plant|substation|cogen|co-gen|power house|powerhouse|steam|energy facility|switching|generating", re.I)
# Substations that feed trains, not buildings.
TRACTION = re.compile(r"\b(IRT|BMT|IND|MTA|PATH|Amtrak|railroad|railway|transit|traction|LIRR|BART|MBTA)\b", re.I)


def _power_sites(features: list[dict[str, Any]], box: dict[str, float]) -> list[dict[str, Any]]:
    """Mapped plants and substations, nearest the campus first. Rooftop-scale sites are skipped."""
    sites = []
    for f in features:
        tags = f["tags"]
        kind = tags.get("power")
        if kind not in ("plant", "substation"):
            continue
        if tags.get("substation") in ("minor_distribution", "transition", "traction") or tags.get("location") == "kiosk":
            continue
        operator = tags.get("operator") or ""
        if TRACTION.search(" ".join(f["names"] + [operator])) or tags.get("railway"):
            continue
        named = bool(f["names"])
        name = f["names"][0] if named else (f"{operator} substation".strip().capitalize() if kind == "substation" else "Power plant")
        sites.append({
            "name": name, "named": named, "kind": kind, "operator": operator, "lat": f["lat"], "lng": f["lng"], "osm": f["osm"],
            "source": tags.get("plant:source") or tags.get("generator:source") or "",
            "distance_m": round(_meters(box["lat"], box["lng"], f["lat"], f["lng"])),
        })
    # The same substation is often mapped as both an outline and a point.
    unique: list[dict[str, Any]] = []
    # Nearest first, but a named site beats an anonymous one at a similar distance.
    for site in sorted(sites, key=lambda s: s["distance_m"] + (0 if s["named"] else 800)):
        if not any(_meters(site["lat"], site["lng"], u["lat"], u["lng"]) < 120 for u in unique):
            unique.append(site)
    return unique


async def _ground(query: str, found: dict[str, Any]) -> dict[str, Any]:
    hints = found["buildings"]
    async with httpx.AsyncClient(timeout=35, headers=OSM_HEADERS) as client:
        box = await _campus_box(client, found.get("name") or query, hints)
        if box is None:
            raise RuntimeError("the place could not be located")
        # The model repeating one coordinate for several buildings means it did not know where they are.
        seen: dict[tuple[float, float], int] = {}
        for b in hints:
            key = (round(b["lat"], 4), round(b["lng"], 4))
            seen[key] = seen.get(key, 0) + 1
        trusted = [k for k, count in seen.items() if count <= 2 and _meters(box["lat"], box["lng"], k[0], k[1]) <= MAX_SPAN_KM * 1000]
        features = await _mapped_features(client, box, trusted)

        placed: list[dict[str, Any]] = []
        dropped: list[str] = []
        used: set[str] = set()
        for b in hints:
            # Two entries can honestly share a spot (a plant in a building's basement). Three or more is a guess.
            guessed = seen[(round(b["lat"], 4), round(b["lng"], 4))] > 2
            hint = None if guessed else (b["lat"], b["lng"])
            is_power = b["role"] == "power"
            match = _best_match(b["name"], features, hint, power=is_power)
            if match is None and is_power:
                # Many campus plants are mapped as plain buildings.
                match = _best_match(b["name"], features, hint)
            if is_power and not (PLANT_WORDS.search(b["name"]) or (match and match["tags"].get("power"))):
                # An office that manages utilities is not a source of power.
                b = {**b, "role": "civic"}
            if match is None:
                match = await _geocode(client, b["name"], box)
            if match is not None:
                if match["osm"] in used:
                    continue
                used.add(match["osm"])
                placed.append({**b, "lat": match["lat"], "lng": match["lng"], "located": "map", "osm": match["osm"],
                               "moved_m": round(_meters(b["lat"], b["lng"], match["lat"], match["lng"]))})
            elif not guessed and _meters(box["lat"], box["lng"], b["lat"], b["lng"]) <= MAX_SPAN_KM * 1000:
                placed.append({**b, "located": "model", "osm": None, "moved_m": None})
            else:
                dropped.append(b["name"])

        if placed:
            middle = {"lat": sum(b["lat"] for b in placed) / len(placed), "lng": sum(b["lng"] for b in placed) / len(placed)}
        else:
            middle = box
        power_checked = True
        try:
            power_features = await _power_features(client, middle["lat"], middle["lng"])
        except RuntimeError:
            power_features, power_checked = [], False

    features = features + power_features
    placed = _with_hospital(placed, power_features, middle)
    sites = _power_sites(power_features, middle)
    placed = _with_named_plant(placed, features, (found.get("power") or {}).get("on_campus_plant") or "")
    placed = _with_power(placed, sites, found.get("power") or {}, found.get("name") or query)
    _assign_feeds(placed)
    on_map = sum(1 for b in placed if b["located"] == "map")
    return {
        **found,
        "buildings": placed[:MAX_BUILDINGS],
        "power_sites": sites[:6],
        "placement": {
            "checked": True,
            # False when the map servers were too busy to list power sites, so the result is not worth saving.
            "power_checked": power_checked,
            "on_map": on_map,
            "from_model": len(placed) - on_map,
            "dropped": dropped,
            "note": "Positions come from OpenStreetMap. Which building is on which feed is assumed: each is put on its nearest power source.",
        },
    }


async def _geocode(client: httpx.AsyncClient, name: str, box: dict[str, float]) -> dict[str, Any] | None:
    """One building by name, inside the campus box only. The service allows one request a second."""
    await asyncio.sleep(1.05)
    resp = await client.get(NOMINATIM_URL, params={
        "q": name, "format": "jsonv2", "limit": 1, "bounded": 1,
        "viewbox": f"{box['west']},{box['north']},{box['east']},{box['south']}",
    })
    hit = (resp.json() or [None])[0] if resp.status_code == 200 else None
    if not hit or _similarity(name, hit.get("name") or hit.get("display_name", "").split(",")[0]) < MATCH_FLOOR:
        return None
    return {"lat": float(hit["lat"]), "lng": float(hit["lon"]), "osm": f"{hit.get('osm_type')}/{hit.get('osm_id')}", "tags": {}, "names": []}


def _with_named_plant(placed: list[dict[str, Any]], features: list[dict[str, Any]], plant_names: str) -> list[dict[str, Any]]:
    """Add the campus plant the research named, if the map has it and the building list does not."""
    for part in re.split(r"[;,/]| and ", plant_names):
        part = part.strip()
        if not part or any(b["role"] == "power" and _similarity(part, b["name"]) >= MATCH_FLOOR for b in placed):
            continue
        match = _best_match(part, features, None, power=True) or _best_match(part, features, None)
        if match is None or any(_meters(match["lat"], match["lng"], b["lat"], b["lng"]) < 60 for b in placed):
            continue
        placed = placed + [{
            "name": match["names"][0] if match["names"] else part, "role": "power", "lat": match["lat"], "lng": match["lng"],
            "located": "map", "osm": match["osm"], "moved_m": None,
            "why": "The campus's own plant, named in the research on how the campus is powered.",
        }]
    return placed


def _with_hospital(placed: list[dict[str, Any]], nearby: list[dict[str, Any]], middle: dict[str, float]) -> list[dict[str, Any]]:
    """An outage plan needs to know where the nearest hospital is, whoever runs it."""
    if any(b["role"] == "hospital" for b in placed):
        return placed
    hospitals = [f for f in nearby if f["tags"].get("amenity") == "hospital" and f["tags"].get("healthcare:speciality") != "veterinary"]
    # Prefer one that takes emergencies; a specialist clinic tagged as a hospital is little use in an outage.
    hospitals.sort(key=lambda f: (f["tags"].get("emergency") != "yes", _meters(middle["lat"], middle["lng"], f["lat"], f["lng"])))
    if not hospitals:
        return placed
    h = hospitals[0]
    away = round(_meters(middle["lat"], middle["lng"], h["lat"], h["lng"]) / 100) / 10
    return placed + [{
        "name": h["names"][0], "role": "hospital", "lat": h["lat"], "lng": h["lng"], "located": "map", "osm": h["osm"], "moved_m": None,
        "why": f"Nearest hospital, about {away} km from the middle of campus. Not named by the research; added from OpenStreetMap.",
    }]


def _with_power(placed: list[dict[str, Any]], sites: list[dict[str, Any]], told: dict[str, str], campus: str = "") -> list[dict[str, Any]]:
    """Make sure the set has real power sources: the campus plant if mapped, and the nearest substations."""
    power = [b for b in placed if b["role"] == "power"]
    others = [b for b in placed if b["role"] != "power"]
    have = lambda site: any(_meters(site["lat"], site["lng"], b["lat"], b["lng"]) < 150 for b in power)  # noqa: E731
    plant_name = told.get("on_campus_plant") or ""
    wanted: list[dict[str, Any]] = []
    for site in sites:
        named_plant = site["named"] and any(_similarity(part, site["name"]) >= MATCH_FLOOR for part in re.split(r"[;,/]| and ", plant_name) if part.strip())
        # A solar or wind farm offsets the campus bill; it is not what a building's feeder hangs off.
        intermittent = site["source"] in ("solar", "wind") or re.search(r"solar|wind", site["name"], re.I)
        # A plant counts as the campus's own only if the research named it or the institution runs it.
        own = bool(set(_tokens(campus)) & set(_tokens(f"{site['operator']} {site['name']}"))) if campus else False
        if site["kind"] == "plant" and (named_plant or (own and site["distance_m"] <= 2500 and not intermittent)):
            wanted.append(site)
    wanted += [s for s in sites if s["kind"] == "substation"][:2]
    for site in wanted:
        if len(power) >= 3 or have(site):
            continue
        by = f" operated by {site['operator']}" if site["operator"] else ""
        what = "Power plant" if site["kind"] == "plant" else "Electrical substation"
        power.append({
            "name": site["name"], "role": "power", "lat": site["lat"], "lng": site["lng"], "located": "map", "osm": site["osm"],
            "moved_m": None, "why": f"{what}{by}, about {site['distance_m']} m from the centre of campus. From OpenStreetMap.",
        })
    return power + others


def _assign_feeds(placed: list[dict[str, Any]]) -> None:
    """Put each building on its nearest power source. An assumption, labelled as one in the response."""
    sources = [b for b in placed if b["role"] == "power"]
    for index, b in enumerate(placed):
        b["id"] = f"{re.sub(r'[^a-z0-9]+', '-', b['name'].lower()).strip('-') or 'place'}-{index}"
    for b in placed:
        if b["role"] == "power" or not sources:
            b["feed"] = None
            continue
        b["feed"] = min(sources, key=lambda s: _meters(s["lat"], s["lng"], b["lat"], b["lng"]))["id"]
