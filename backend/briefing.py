"""
Plain-language answers for an outage: dorms vs classrooms, buses, cooling centers,
and the other systems that move with that choice.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from graph import CampusGraph, Node, NodeType, Status

COOLING_TYPES = {NodeType.DINING, NodeType.LIBRARY}
ROUTES_PATH = Path(__file__).resolve().parent / "data" / "bus_routes.json"


def debrief_facts(graph: CampusGraph, preference: str, activity: list[str]) -> dict:
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
        "tick": graph.tick_count,
        "scale": "Kilowatts are a demo scale, not the real megawatts. University Hospital and Mott are never shed. City Hall, Blake Transit Center, and Fire Station 1 are on the city grid.",
        "nodes": nodes,
        "briefing": build_briefing(graph, preference),
        "activity": activity[-24:],
    }


def build_briefing(graph: CampusGraph, preference: str) -> dict:
    nodes = list(graph.nodes.values())
    disrupted = any(n.status != Status.GREEN or n.failed for n in nodes)
    displaced = sum(max(0, n.baseline_occupancy - n.occupancy) for n in nodes if n.status == Status.RED)

    return {
        "preference": preference,
        "disrupted": disrupted,
        "displaced": displaced,
        "priority": _priority(nodes, preference, displaced),
        "buses": _buses(nodes),
        "cooling": _cooling(nodes, displaced),
        "systems": _systems(nodes),
    }


def _priority(nodes: list[Node], preference: str, displaced: int) -> dict:
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

    return {
        "answer": answer,
        "dorms_dark": dorms_dark,
        "classrooms_dark": class_dark,
        "dorms_lit": dorms_lit,
        "classrooms_lit": class_lit,
        "displaced": displaced,
    }


def _buses(nodes: list[Node]) -> dict:
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
    if not broken:
        answer = "No. Every bus that serves this map still stops at lit buildings."
    else:
        answer = "Yes. Do not unload at a dark stop. Hold riders for the next lit stop on that route."
    return {"answer": answer, "reroute": broken}


def _cooling(nodes: list[Node], displaced: int) -> dict:
    centers = [
        n for n in nodes
        if n.status == Status.GREEN and not n.failed and (n.type in COOLING_TYPES or n.id == "city_hall")
    ]
    centers.sort(key=lambda n: n.occupancy)
    picked = centers[:3]
    if displaced <= 0:
        answer = "Not for this outage. Nobody has been moved out of a dark building."
    elif not picked:
        answer = "Nowhere left to open. The commons, libraries, and city buildings on this map are dark too."
    else:
        names = ", ".join(n.name for n in picked)
        answer = f"Yes. Open {names}. They still have power and can take people who left a dark building."
    return {
        "answer": answer,
        "open": displaced > 0 and bool(picked),
        "places": [{"id": n.id, "name": n.name, "occupancy": n.occupancy} for n in picked],
    }


def _systems(nodes: list[Node]) -> list[dict]:
    def row(label: str, ids: list[str], note: str) -> dict:
        group = [n for n in nodes if n.id in ids]
        dark = [n.name for n in group if n.status == Status.RED]
        return {"system": label, "status": "down" if dark else "up", "detail": note if not dark else ", ".join(dark) + " dark. " + note}

    cpp = next(n for n in nodes if n.id == "cpp")
    hospital_note = "Adult and children's hospitals stay on their own feed."
    if cpp.status == Status.RED:
        hospital_note = "The power-plant tie into the hospital is gone. Mott still has the hospital's own intake."
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
    # Drop the heavy road geometry. The briefing only needs which buildings a route passes.
    slim = []
    for pattern in doc.get("patterns") or []:
        slim.append({
            "agency": pattern.get("agency"),
            "id": pattern.get("id"),
            "name": pattern.get("name"),
            "near_nodes": pattern.get("near_nodes") or [],
        })
    return tuple(slim)
