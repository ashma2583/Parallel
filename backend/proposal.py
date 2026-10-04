"""
A planned U-M building dropped onto the live campus.

The planner supplies the people and the kilowatts. Those are assumptions in
the same demo scale as the rest of the model. The feed, the walk, and the
buses come from where they clicked.
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

from agents.logic import NO_EVACUEES
from graph import CampusGraph, Node, NodeType, Priority, supply_for

# Same coordinates as the map. City buildings are not part of a campus feed.
PLACES: dict[str, tuple[float, float]] = {
    "cpp": (-83.7364, 42.282),
    "uh": (-83.7286, 42.2836),
    "north_switch": (-83.7048, 42.2976),
    "angell": (-83.7394, 42.2769),
    "shapiro": (-83.737, 42.2755),
    "union": (-83.7416, 42.2752),
    "ross": (-83.7383, 42.2709),
    "markley": (-83.7298, 42.2807),
    "south_quad": (-83.7368, 42.2736),
    "mott": (-83.7262, 42.2827),
    "kahn": (-83.7236, 42.2839),
    "beyster": (-83.7161, 42.2927),
    "duderstadt": (-83.7156, 42.2911),
    "pierpont": (-83.7178, 42.2914),
    "bursley": (-83.7202, 42.2948),
    "gg_brown": (-83.7138, 42.2933),
    "ncrc": (-83.6925, 42.3052),
}
FEEDS = (
    ("central", "cpp", "Central Power Plant"),
    ("medical", "uh", "University Hospital"),
    ("north", "north_switch", "North Campus feed"),
)
TYPES = {
    "dorm": (NodeType.DORM, Priority.HIGH),
    "academic": (NodeType.ACADEMIC, Priority.HIGH),
    "research": (NodeType.RESEARCH, Priority.MEDIUM),
    "dining": (NodeType.DINING, Priority.MEDIUM),
    "library": (NodeType.LIBRARY, Priority.LOW),
}
MAX_PROPOSALS = 3
CAMPUS_LIMIT_M = 3500
BUS_LIMIT_M = 220
ROUTES_PATH = Path(__file__).resolve().parent / "data" / "bus_routes.json"


class ProposalError(ValueError):
    pass


def place_proposal(graph: CampusGraph, *, name: str, kind: str, lng: float, lat: float, demand: float, people: int) -> dict:
    if kind not in TYPES:
        raise ProposalError("Type must be a residence hall, classroom, lab, commons, or library.")
    if len(graph.proposals) >= MAX_PROPOSALS:
        raise ProposalError("Three planned buildings are enough for one what-if. Remove one first.")
    feeder, source, label = _nearest_feed(lng, lat)
    if _meters(lng, lat, *PLACES[source]) > CAMPUS_LIMIT_M:
        raise ProposalError("Place it on central, medical, or north campus.")
    neighbor = _nearest_building(graph, lng, lat)
    node_type, priority = TYPES[kind]
    node_id = _next_id(graph)
    anchor = graph.nodes[source]
    slot = len(graph.proposals)
    node = Node(
        node_id,
        name.strip(),
        node_type,
        priority,
        feeder,
        demand=float(demand),
        occupancy=int(people),
        position={"x": anchor.position["x"] + 110, "y": anchor.position["y"] + 70 + slot * 80},
    )
    before = _feeder_picture(graph, feeder)
    shed_before = {n.id: n.load_shed for n in graph.nodes.values()}
    graph.add_proposal(
        node,
        {"lat": lat, "lng": lng, "feeder": feeder, "walks_to": neighbor},
        source,
        neighbor,
    )
    return {
        "node_id": node_id,
        "before": before,
        "shed_before": shed_before,
        "feeder": feeder,
        "feeder_label": label,
        "source": source,
        "walks_to": neighbor,
        "lng": lng,
        "lat": lat,
    }


def describe(graph: CampusGraph, placed: dict) -> dict:
    node = graph.nodes[placed["node_id"]]
    after = _feeder_picture(graph, placed["feeder"])
    shed = []
    for existing_id, previous in placed["shed_before"].items():
        current = graph.nodes.get(existing_id)
        if current and current.load_shed > previous + 0.01:
            shed.append(current.name)
    if node.load_shed > 0.01:
        shed.append(node.name)
    walks = graph.nodes[placed["walks_to"]].name
    return {
        "id": node.id,
        "name": node.name,
        "type": node.type.value,
        "people": node.occupancy,
        "demand_kw": round(node.demand),
        "received_kw": round(node.current_power),
        "status": node.status.value,
        "feeder": placed["feeder"],
        "feeder_label": placed["feeder_label"],
        "feeder_id": placed["source"],
        "supply_kw": round(after["supply"]),
        "demand_before_kw": round(placed["before"]["demand"]),
        "demand_after_kw": round(after["demand"]),
        "headroom_kw": round(after["supply"] - after["demand"]),
        "shed": shed,
        "walks_to": walks,
        "buses": buses_near(placed["lng"], placed["lat"]),
        "lat": placed["lat"],
        "lng": placed["lng"],
    }


def list_proposals(graph: CampusGraph) -> list[dict]:
    rows = []
    for node_id, meta in graph.proposals.items():
        node = graph.nodes.get(node_id)
        if not node:
            continue
        rows.append({
            "id": node.id,
            "name": node.name,
            "type": node.type.value,
            "status": node.status.value,
            "lat": meta["lat"],
            "lng": meta["lng"],
            "feeder_id": _source_for(meta["feeder"]),
            "people": node.occupancy,
            "demand_kw": round(node.demand),
            "received_kw": round(node.current_power),
        })
    return rows


def _feeder_picture(graph: CampusGraph, feeder: str) -> dict:
    demand = sum(
        node.effective_demand
        for node in graph.nodes.values()
        if node.feeder == feeder and not node.is_supplier
    )
    return {"supply": supply_for(graph.nodes, feeder, graph.cut_edges), "demand": demand}


def _nearest_feed(lng: float, lat: float) -> tuple[str, str, str]:
    return min(FEEDS, key=lambda feed: _meters(lng, lat, *PLACES[feed[1]]))


def _source_for(feeder: str) -> str:
    for name, source, _label in FEEDS:
        if name == feeder:
            return source
    return "cpp"


def _nearest_building(graph: CampusGraph, lng: float, lat: float) -> str:
    """Where its people walk if it goes dark. Like the transit agent, never a feed or a hospital."""
    best = "angell"
    best_distance = float("inf")
    for node_id, coord in PLACES.items():
        if node_id not in graph.nodes or graph.nodes[node_id].type in NO_EVACUEES:
            continue
        distance = _meters(lng, lat, *coord)
        if distance < best_distance:
            best = node_id
            best_distance = distance
    return best


def _next_id(graph: CampusGraph) -> str:
    taken = {int(node_id.removeprefix("plan_")) for node_id in graph.proposals if node_id.startswith("plan_")}
    number = 1
    while number in taken:
        number += 1
    return f"plan_{number}"


def buses_near(lng: float, lat: float) -> list[dict]:
    found = []
    seen: set[str] = set()
    for route in _um_routes():
        if route["id"] in seen:
            continue
        if any(_meters(lng, lat, point[0], point[1]) <= BUS_LIMIT_M for point in route["points"]):
            seen.add(route["id"])
            found.append({"id": route["id"], "name": route["name"]})
        if len(found) == 6:
            break
    return found


@lru_cache(maxsize=1)
def _um_routes() -> tuple:
    if not ROUTES_PATH.exists():
        return tuple()
    doc = json.loads(ROUTES_PATH.read_text())
    routes = []
    for pattern in doc.get("patterns") or []:
        if pattern.get("agency") != "umich":
            continue
        shape = pattern.get("shape") or []
        points = tuple((pair[0], pair[1]) for pair in shape[::8] if len(pair) >= 2)
        if len(points) < 2:
            continue
        routes.append({"id": pattern.get("id") or "", "name": pattern.get("name") or "", "points": points})
    return tuple(routes)


def _meters(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    lat = ((lat1 + lat2) / 2) * math.pi / 180
    x = (lng1 - lng2) * math.cos(lat) * 111_320
    y = (lat1 - lat2) * 110_540
    return math.hypot(x, y)
