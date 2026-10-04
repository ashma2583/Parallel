"""
Plain-language answers for an outage: dorms vs classrooms, buses, cooling centers,
and the other systems that move with that choice.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import occupancy
from agents.logic import cut_off_by_roads
from graph import CampusGraph, Node, NodeType, Status
import storms

COOLING_TYPES = {NodeType.DINING, NodeType.LIBRARY}
ROUTES_PATH = Path(__file__).resolve().parent / "data" / "bus_routes.json"
# Where each building stands, [lng, lat], copied from frontend/src/lib/places.ts.
PLACES: dict[str, tuple[float, float]] = {
    "cpp": (-83.7364, 42.282), "uh": (-83.7286, 42.2836), "north_switch": (-83.7048, 42.2976),
    "angell": (-83.7394, 42.2769), "shapiro": (-83.737, 42.2755), "union": (-83.7416, 42.2752),
    "ross": (-83.7383, 42.2709), "markley": (-83.7298, 42.2807), "south_quad": (-83.7368, 42.2736),
    "mott": (-83.7262, 42.2827), "kahn": (-83.7236, 42.2839),
    "beyster": (-83.7161, 42.2927), "duderstadt": (-83.7156, 42.2911), "pierpont": (-83.7178, 42.2914),
    "bursley": (-83.7202, 42.2948), "gg_brown": (-83.7138, 42.2933), "ncrc": (-83.6925, 42.3052),
    "city_hall": (-83.7486, 42.2813), "blake": (-83.7483, 42.2786), "fire_1": (-83.7484, 42.2817),
}
# Meters per degree at Ann Arbor. Flat is close enough across one campus.
M_PER_LAT = 111_132.0
M_PER_LNG = 111_320.0 * math.cos(math.radians(42.28))
# A stop this close to a closed stretch is on it.
ON_STRETCH_M = 40.0
# Closed stretches whose middles are this close are named as one place.
SAME_STRETCH_M = 500.0


def people_facts(graph: CampusGraph) -> dict:
    """Students in class right now, for the language model: the slot and the busiest buildings."""
    now = occupancy.people_now(graph)
    return {
        "slot": now["slot"],
        "weekday": now["weekday"],
        "students_in_class": now["total"],
        "note": "Students in class by building at this time of day, from the class schedule and campus events. A building's people count in nodes follows it.",
        "buildings": [
            {"node_id": row["node_id"], "name": row["name"], "students": row["students"]}
            for row in now["buildings"]
            if row["students"] > 0
        ],
    }


def debrief_facts(graph: CampusGraph, preference: str, activity: list[str], season: str = "fall") -> dict:
    """Compact snapshot for the after-action summary. Numbers stay as the sim has them."""
    nodes = [
        {
            "name": n.name,
            "type": n.type.value,
            "feeder": n.feeder,
            "status": n.status.value,
            "failed": n.failed,
            "kw": round(n.current_power),
            "demand_kw": round(n.demand),
            "people": n.occupancy,
            "people_before": n.baseline_occupancy,
            "shed": round(n.load_shed, 2),
        }
        for n in graph.nodes.values()
    ]
    return {
        "preference": preference,
        "season": season,
        "tick": graph.tick_count,
        "scale": "Kilowatts are a demo scale, not the real megawatts. University Hospital and Mott are never shed. City Hall, Blake Transit Center, and Fire Station 1 are on the city grid.",
        "nodes": nodes,
        "people_now": people_facts(graph),
        "briefing": {**build_briefing(graph, preference, season), "weather": storms.weather_digest(graph)},
        "activity": activity[-24:],
    }


def build_briefing(graph: CampusGraph, preference: str, season: str = "fall") -> dict:
    nodes = list(graph.nodes.values())
    disrupted = any(n.status != Status.GREEN or n.failed for n in nodes) or storms.has_weather(graph) or graph.heat_wave is not None
    displaced = sum(max(0, n.baseline_occupancy - n.occupancy) for n in nodes if n.status == Status.RED)
    sheltering = _sheltering(graph, nodes)

    return {
        "preference": preference,
        "season": season if season in {"summer", "fall", "winter", "spring"} else "fall",
        "disrupted": disrupted,
        "displaced": displaced,
        "sheltering": sum(n.occupancy for n, _ in sheltering),
        "priority": _priority(nodes, preference, displaced, sheltering),
        "buses": _buses(nodes, graph),
        "shelter": (shelter := _shelter(nodes, displaced, sheltering, season, cooling=graph.heat_wave is not None or season == "summer")),
        # Same places, so older clients that still read "cooling" keep working.
        "cooling": {"answer": shelter["answer"], "open": shelter["open"], "places": shelter["places"]},
        "systems": _systems(nodes, graph.tie_cut()),
        "heat_wave": graph.heat_wave_view(),
        "weather": storms.weather_state(graph),
    }


def _sheltering(graph: CampusGraph, nodes: list[Node]) -> list[tuple[Node, str]]:
    """Dark buildings whose people the transit agent could not move, most people first, with why. Hospitals keep their patients by design."""
    held = getattr(graph, "sheltering", set())
    found = [
        (n, "roads are closed" if cut_off_by_roads(graph, n.id) else "nothing lit is in reach")
        for n in nodes
        if n.id in held and n.status == Status.RED and n.occupancy > 0 and n.type != NodeType.HOSPITAL
    ]
    return sorted(found, key=lambda pair: (-pair[0].occupancy, pair[0].name))


def _shelter_text(sheltering: list[tuple[Node, str]], more: bool = False) -> str:
    """1,200 people are sheltering in place at Mary Markley Hall; roads are closed."""
    total = sum(n.occupancy for n, _ in sheltering)
    who = f"{total:,} more" if more else _people(total)
    verb = "is" if total == 1 else "are"
    whys = list(dict.fromkeys(why for _, why in sheltering))
    why = whys[0] if len(whys) == 1 else "roads are closed or nothing lit is in reach"
    if len(sheltering) == 1:
        return f"{who} {verb} sheltering in place at {sheltering[0][0].name}; {why}."
    top = [f"{n.name} ({n.occupancy:,})" for n, _ in sheltering[:2]]
    return f"{who} {verb} sheltering in place in {len(sheltering)} dark buildings, most at {' and '.join(top)}; {why}."


def _people(count: int) -> str:
    return f"{count:,} person" if count == 1 else f"{count:,} people"


def _priority(nodes: list[Node], preference: str, displaced: int, sheltering: list[tuple[Node, str]]) -> dict:
    dorms_dark = _count(nodes, lambda n: n.type == NodeType.DORM and n.status == Status.RED)
    class_dark = _count(nodes, lambda n: n.type in (NodeType.ACADEMIC, NodeType.LIBRARY) and n.status == Status.RED)
    dorms_lit = _count(nodes, lambda n: n.type == NodeType.DORM and n.status == Status.GREEN)
    class_lit = _count(nodes, lambda n: n.type in (NodeType.ACADEMIC, NodeType.LIBRARY) and n.status == Status.GREEN)

    if preference == "residential":
        answer = "Keep the dorms lit. Classrooms and libraries on a short feed are shut first."
    elif preference == "academic":
        answer = "Keep classes lit. Residence halls on a short feed are shut first."
    elif preference == "people":
        answer = "Keep whichever buildings hold the most people per kilowatt. That can mean a full library stays lit while a lab goes dark."
    elif preference == "even":
        answer = "Neither. Nothing is shed, so every building on a short feed gets the same reduced share."
    else:
        answer = "Protect the hospital only. Libraries and commons go dark before dorms or classrooms. University Hospital and Mott are never shed."
    if preference != "tiered" and dorms_dark and class_dark:
        answer += " A feed with no power left still goes fully dark. The choice matters when a feed is short, not dead."
    in_dorms = sum(n.occupancy for n, _ in sheltering if n.type == NodeType.DORM)
    in_class = sum(n.occupancy for n, _ in sheltering if n.type in (NodeType.ACADEMIC, NodeType.LIBRARY))
    if in_dorms and in_class:
        answer += f" Right now {_people(in_dorms)} are sheltering in place in dark dorms and {in_class:,} in dark classrooms."
    elif in_dorms or in_class:
        where = "dorms" if in_dorms else "classrooms"
        count = in_dorms or in_class
        answer += f" Right now {_people(count)} {'is' if count == 1 else 'are'} sheltering in place in dark {where}."

    return {
        "answer": answer,
        "dorms_dark": dorms_dark,
        "classrooms_dark": class_dark,
        "dorms_lit": dorms_lit,
        "classrooms_lit": class_lit,
        "displaced": displaced,
        "sheltering": sum(n.occupancy for n, _ in sheltering),
    }


def _buses(nodes: list[Node], graph: CampusGraph | None = None) -> dict:
    by_id = {n.id: n for n in nodes}
    broken: list[dict] = []
    seen: set[str] = set()
    for pattern in _patterns():
        if pattern.get("agency") != "umich":
            continue
        key = f"{pattern['agency']}:{pattern['id']}"
        if key in seen:
            continue
        dark = [nid for nid in pattern.get("near_nodes") or [] if nid in by_id and by_id[nid].status == Status.RED]
        if not dark:
            continue
        seen.add(key)
        still = [nid for nid in pattern.get("near_nodes") or [] if nid in by_id and by_id[nid].status == Status.GREEN]
        broken.append({
            "id": pattern["id"],
            "name": pattern["name"],
            "agency": "U-M" if pattern["agency"] == "umich" else "TheRide",
            "skip": [by_id[nid].name for nid in dark],
            "keep": [by_id[nid].name for nid in still],
        })
    closed = list(getattr(graph, "closed_routes", None) or [])
    # Each row with every closure on its line, so stretches from several storms add up.
    rows: dict[int, tuple[dict, list[dict]]] = {}
    for route in closed:
        entry = _closed_route_entry(broken, route, by_id)
        rows.setdefault(id(entry), (entry, []))[1].append(route)
        why = storms.route_reason(graph, route)
        # A line out at every stop lists only why, not the stops or stretches it skips.
        whole = [text for text in entry["skip"] if text.startswith("every stop: ")]
        if route.get("segments") is None:
            entry["skip"] = whole + [f"every stop: {why}"]
            entry["keep"] = []
        elif not whole:
            stretch = _stretch(route["segments"], why, by_id)
            if stretch not in entry["skip"]:
                entry["skip"].append(stretch)
    for entry, routes in rows.values():
        if any(r.get("segments") is None for r in routes):
            continue
        _, patterns = _line(entry["id"])
        stops = _stops_closed(patterns, [seg for r in routes for seg in r["segments"]])
        if stops and all(shut for _, shut in stops):
            # The stretches cover every stop, so the line is out, not on a detour.
            alone = [r for r in routes if every_stop_closed(entry["id"], r["segments"])]
            if alone:
                entry["skip"] = list(dict.fromkeys(f"every stop: {storms.route_reason(graph, r)}" for r in alone))
            else:
                who = list(dict.fromkeys(storms.route_cause(graph, r) for r in routes))
                entry["skip"] = [f"every stop: closed by {storms.joined(who)}{' together' if len(who) > 1 else ''}"]
            entry["keep"] = []
            continue
        # Buildings whose every stop on this line is in a closed stretch are not served.
        cut = {by_id[nid].name for nid in _cut_off(stops) if nid in by_id}
        entry["keep"] = [name for name in entry["keep"] if name not in cut]
    if not broken:
        answer = "No. Every bus that serves this map still stops at lit buildings."
    elif not closed:
        answer = "Yes. Do not unload at a dark stop. Hold riders for the next lit stop on that route."
    else:
        skips = [text for entry in broken for text in entry["skip"]]
        parts = ["Yes."]
        if any(not text.startswith(("the stretch", "every stop: ")) for text in skips):
            parts.append("Do not unload at a dark stop.")
        if any(text.startswith("the stretch") for text in skips):
            parts.append("Detour around the closed stretches.")
        if any(text.startswith("every stop: ") for text in skips):
            parts.append("Lines closed at every stop stay in the depot.")
        if any(not text.startswith("every stop: ") for text in skips):
            parts.append("Hold riders for the next lit stop on that route.")
        answer = " ".join(parts)
    return {"answer": answer, "reroute": broken}


def every_stop_closed(route_id: str, segments: list) -> bool:
    """These stretches cover every stop on the line, so it is out, not on a detour."""
    _, patterns = _line(route_id)
    stops = _stops_closed(patterns, segments)
    return bool(stops) and all(shut for _, shut in stops)


def _closed_route_entry(broken: list[dict], route: dict, by_id: dict[str, Node]) -> dict:
    """The reroute row for a bus line the weather or the director closed, made once per line."""
    agency, patterns = _line(route["id"])
    for entry in broken:
        if entry["agency"] == agency and entry["id"] == route["id"]:
            return entry
    near = list(dict.fromkeys(nid for p in patterns for nid in p.get("near_nodes") or []))
    entry = {
        "id": route["id"],
        "name": patterns[0]["name"] if patterns else route.get("name") or route["id"],
        "agency": agency,
        "skip": [],
        "keep": [by_id[nid].name for nid in near if nid in by_id and by_id[nid].status == Status.GREEN],
    }
    broken.append(entry)
    return entry


def _line(route_id: str) -> tuple[str, list[dict]]:
    """Agency and patterns for a line id. U-M ids win; TheRide numbers never clash with them."""
    patterns = [p for p in _patterns() if p.get("id") == route_id]
    umich = [p for p in patterns if p.get("agency") == "umich"]
    if umich or not patterns:
        return "U-M", umich
    return "TheRide", patterns


def _stretch(segments: list, why: str, by_id: dict[str, Node]) -> str:
    """the stretch near Mary Markley Hall closed by the EF3 tornado (debris across the road)."""
    # Both directions of a line, or two hits, close stretches side by side. Those count as one place.
    places: list[list[tuple[float, float]]] = []
    for mid in filter(None, (_midpoint(seg) for seg in segments)):
        group = next((g for g in places if math.dist(g[0], mid) <= SAME_STRETCH_M), None)
        if group is None:
            places.append([mid])
        else:
            group.append(mid)
    names: list[str] = []
    spots = [nid for nid in PLACES if nid in by_id]
    for group in places if spots else []:
        at = (sum(x for x, _ in group) / len(group), sum(y for _, y in group) / len(group))
        nid = min(spots, key=lambda i: math.dist(at, _xy(PLACES[i])))
        if by_id[nid].name not in names:
            names.append(by_id[nid].name)
    if not names:
        return f"the stretch {why}"
    if len(names) == 1:
        return f"the stretch near {names[0]} {why}"
    names = names[:3]
    return f"the stretches near {', '.join(names[:-1])} and {names[-1]} {why}"


def _stops_closed(patterns: list[dict], segments: list) -> list[tuple[tuple[str, ...], bool]]:
    """Every stop on the line: the buildings it serves, and whether it sits in a closed stretch."""
    lines = [[_xy(p) for p in seg] for seg in segments if len(seg) >= 2]
    return [
        (near, any(_to_line(_xy((lng, lat)), line) <= ON_STRETCH_M for line in lines))
        for pattern in patterns
        for lng, lat, near in pattern.get("stops") or ()
    ]


def _cut_off(stops: list[tuple[tuple[str, ...], bool]]) -> set[str]:
    """Buildings every one of whose stops on the line sits in a closed stretch."""
    served: dict[str, list[bool]] = {}
    for near, shut in stops:
        for nid in near:
            served.setdefault(nid, []).append(shut)
    return {nid for nid, flags in served.items() if all(flags)}


def _xy(point) -> tuple[float, float]:
    """[lng, lat] as meters east and north."""
    return point[0] * M_PER_LNG, point[1] * M_PER_LAT


def _midpoint(seg: list) -> tuple[float, float] | None:
    """Halfway along a stretch, in meters."""
    pts = [_xy(p) for p in seg]
    if not pts:
        return None
    half = sum(math.dist(a, b) for a, b in zip(pts, pts[1:])) / 2
    for a, b in zip(pts, pts[1:]):
        step = math.dist(a, b)
        if step > 0 and half <= step:
            f = half / step
            return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        half -= step
    return pts[len(pts) // 2]


def _to_line(p: tuple[float, float], line: list[tuple[float, float]]) -> float:
    """Meters from a point to the nearest place on a polyline."""
    best = math.inf
    for a, b in zip(line, line[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        span = dx * dx + dy * dy
        f = 0.0 if span == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / span))
        best = min(best, math.hypot(p[0] - a[0] - f * dx, p[1] - a[1] - f * dy))
    return best


def _shelter(nodes: list[Node], displaced: int, sheltering: list[tuple[Node, str]], season: str, *, cooling: bool | None = None) -> dict:
    """Summer uses cooling centers. A heat wave does too. The rest of the year uses warming centers."""
    if cooling is None:
        cooling = season == "summer"
    kind = "cooling" if cooling else "warming"
    centers = [
        n for n in nodes
        if n.status == Status.GREEN and not n.failed and _is_shelter(n, cooling)
    ]
    centers.sort(key=lambda n: (0 if n.type == NodeType.DORM else 1, n.occupancy))
    picked = centers[:3]
    names = ", ".join(n.name for n in picked)
    if displaced <= 0 and not sheltering:
        answer = "Not for this outage. Nobody has been moved out of a dark building."
    elif displaced <= 0:
        answer = f"Not yet. Nobody has reached a lit building. {_shelter_text(sheltering)}"
        answer += f" Keep {names} ready for when they can leave." if picked else " The commons, libraries, and city buildings on this map are dark too."
    elif not picked:
        answer = "Nowhere left to open. The powered commons and halls on this map are dark too."
    else:
        if cooling:
            answer = f"Yes. Open {names} as cooling centers. They still have power and can take people out of the heat."
        else:
            answer = f"Yes. Open {names} as warming centers. They still have power and heat, so people can get out of the cold."
    if displaced > 0 and sheltering:
        answer += f" {_shelter_text(sheltering, more=True)}"
    return {
        "kind": kind,
        "answer": answer,
        "open": displaced > 0 and bool(picked),
        "places": [{"id": n.id, "name": n.name, "occupancy": n.occupancy} for n in picked],
    }


def _is_shelter(node: Node, cooling: bool) -> bool:
    if cooling:
        return node.type in COOLING_TYPES or node.id == "city_hall"
    return node.type in {NodeType.DORM, NodeType.DINING, NodeType.LIBRARY}


def _systems(nodes: list[Node], tie_cut: bool = False) -> list[dict]:
    def row(label: str, ids: list[str], note: str) -> dict:
        group = [n for n in nodes if n.id in ids]
        dark = [n.name for n in group if n.status == Status.RED]
        return {"system": label, "status": "down" if dark else "up", "detail": note if not dark else ", ".join(dark) + " dark. " + note}

    by_id = {n.id: n for n in nodes}
    tie_gone = tie_cut or by_id["cpp"].status == Status.RED
    kahn, mott = by_id["kahn"], by_id["mott"]
    hospital_note = "Adult and children's hospitals stay on their own feed."
    if by_id["uh"].status == Status.RED:
        generators = not kahn.failed and kahn.derate > 0
        if kahn.status == Status.RED and mott.status == Status.RED:
            rest = "The whole medical campus is dark."
        elif not tie_gone and generators:
            rest = "The power-plant tie and Kahn's generators carry the rest of the medical campus."
        elif not tie_gone:
            rest = "Kahn is down, so only the power-plant tie carries the rest of the medical campus."
        elif generators:
            rest = "Kahn's generators are all the medical campus has left."
        else:
            rest = "The power-plant tie and Kahn are down too."
        hospital_note = f"The hospital's own intake is down. {rest}"
    elif tie_gone:
        hospital_note = "The power-plant tie into the hospital is gone." + (
            "" if mott.status == Status.RED else " Mott still has the hospital's own intake.")
    return [
        row("Dining", ["south_quad", "markley", "bursley", "pierpont", "union"], "Meals are served in the dorms and at Pierpont and the Union."),
        row("Housing", ["markley", "south_quad", "bursley"], "These three halls are where residents sleep."),
        row("Hospital", ["uh", "mott", "kahn"], hospital_note),
        row("Research", ["beyster", "ncrc", "gg_brown"], "Labs and the research complex are on the north feed."),
        row("City safety", ["fire_1", "city_hall"], "City Hall and Fire Station 1 are on the city grid, not the campus plant."),
    ]


def _count(nodes: list[Node], pred) -> int:
    return sum(n.occupancy for n in nodes if pred(n))


@lru_cache(maxsize=1)
def route_collection() -> dict:
    """Road shapes for the map. Stops are omitted."""
    features = []
    if ROUTES_PATH.exists():
        doc = json.loads(ROUTES_PATH.read_text())
        for pattern in doc.get("patterns") or []:
            shape = pattern.get("shape") or []
            if len(shape) < 2:
                continue
            features.append({
                "type": "Feature",
                "properties": {
                    "id": pattern.get("id"),
                    "name": pattern.get("name"),
                    "agency": "U-M" if pattern.get("agency") == "umich" else "TheRide",
                    "direction": pattern.get("direction"),
                    "near": pattern.get("near_nodes") or [],
                },
                "geometry": {"type": "LineString", "coordinates": shape},
            })
    return {"type": "FeatureCollection", "features": features}


@lru_cache(maxsize=1)
def _patterns() -> tuple:
    if not ROUTES_PATH.exists():
        return tuple()
    doc = json.loads(ROUTES_PATH.read_text())
    # Drop the heavy road geometry. The briefing needs which buildings a route passes and where its stops are.
    slim = []
    for pattern in doc.get("patterns") or []:
        slim.append({
            "agency": pattern.get("agency"),
            "id": pattern.get("id"),
            "name": pattern.get("name"),
            "near_nodes": pattern.get("near_nodes") or [],
            "stops": tuple(
                (float(stop["lon"]), float(stop["lat"]), tuple(stop.get("near") or []))
                for stop in pattern.get("stops") or []
                if stop.get("lon") is not None and stop.get("lat") is not None
            ),
        })
    return tuple(slim)
