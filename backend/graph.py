"""
PARALLEL campus graph.

Twenty places in Ann Arbor, on the three real electrical intakes:

  * Central Power Plant (cogeneration) feeds central campus, and a small
    emergency tie can reach the medical campus.
  * University Hospital brings in the DTE Academy feed for Michigan Medicine.
    Kahn Pavilion also has its own generators.
  * North Campus Switching Station feeds north campus from DTE. NCRC has a
    little generation of its own.
  * City Hall, Blake Transit Center, and Fire Station 1 are on the city DTE
    network. A campus outage does not take them down.

Numbers are demo-scale kilowatts, not the real megawatts.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class NodeType(str, Enum):
    SUBSTATION = "substation"
    HOSPITAL = "hospital"
    DORM = "dorm"
    DINING = "dining"
    LIBRARY = "library"
    TRANSIT = "transit"
    ACADEMIC = "academic"
    RESEARCH = "research"
    CIVIC = "civic"


class Priority(int, Enum):
    CRITICAL = 0
    HIGH = 1
    MEDIUM = 2
    LOW = 3
    NONE = 9


class Status(str, Enum):
    GREEN = "Green"
    AMBER = "Amber"
    RED = "Red"


class EdgeType(str, Enum):
    POWER = "power"
    ROAD = "road"


GREEN_THRESHOLD = 0.90
AMBER_THRESHOLD = 0.50
# Emergency feeder from the Central Power Plant into Michigan Medicine.
MEDICAL_TIE_KW = 140.0


@dataclass
class Node:
    id: str
    name: str
    type: NodeType
    priority: Priority
    feeder: str
    capacity: float = 0.0
    demand: float = 0.0
    local_supply: float = 0.0
    current_power: float = 0.0
    occupancy: int = 0
    status: Status = Status.GREEN
    failed: bool = False
    load_shed: float = 0.0
    baseline_occupancy: int = 0
    position: dict[str, float] = field(default_factory=dict)

    @property
    def is_supplier(self) -> bool:
        return self.type == NodeType.SUBSTATION

    @property
    def effective_demand(self) -> float:
        if self.is_supplier or self.failed:
            return 0.0
        return self.demand * (1.0 - max(0.0, min(1.0, self.load_shed)))

    @property
    def power_ratio(self) -> float:
        nominal = self.capacity if self.is_supplier else self.demand
        if nominal <= 0:
            return 0.0
        return self.current_power / nominal


@dataclass
class Edge:
    id: str
    source: str
    target: str
    type: EdgeType


@dataclass
class TickResult:
    tick: int
    supply: float
    demand: float
    deficit: float
    power_ratio: float
    failed_nodes: list[str]
    status_counts: dict[str, int]


def supply_for(nodes: dict[str, Node], feeder: str) -> float:
    """Kilowatts available on one electrical island."""
    total = 0.0
    for node in nodes.values():
        if node.feeder != feeder or node.failed:
            continue
        total += node.capacity if node.is_supplier else node.local_supply
    if feeder == "medical":
        cpp = nodes.get("cpp")
        if cpp and not cpp.failed:
            total += MEDICAL_TIE_KW
    return total


def _build_nodes() -> list[Node]:
    n = NodeType
    p = Priority
    return [
        # Feeds
        Node("cpp", "Central Power Plant", n.SUBSTATION, p.NONE, "central",
             capacity=620, occupancy=40, position={"x": 520, "y": 220}),
        Node("uh", "University Hospital", n.HOSPITAL, p.CRITICAL, "medical",
             demand=260, local_supply=640, occupancy=800, position={"x": 860, "y": 80}),
        Node("north_switch", "North Campus Switching Station", n.SUBSTATION, p.NONE, "north",
             capacity=560, occupancy=12, position={"x": 1180, "y": 40}),

        # Central campus, on the power plant
        Node("angell", "Angell Hall", n.ACADEMIC, p.HIGH, "central",
             demand=90, occupancy=400, position={"x": 220, "y": 80}),
        Node("shapiro", "Shapiro Undergraduate Library", n.LIBRARY, p.LOW, "central",
             demand=60, occupancy=500, position={"x": 220, "y": 280}),
        Node("union", "Michigan Union", n.DINING, p.MEDIUM, "central",
             demand=50, occupancy=350, position={"x": 40, "y": 180}),
        Node("ross", "Ross School of Business", n.ACADEMIC, p.MEDIUM, "central",
             demand=80, occupancy=400, position={"x": 220, "y": 460}),
        Node("markley", "Mary Markley Hall", n.DORM, p.HIGH, "central",
             demand=110, occupancy=1200, position={"x": 520, "y": 40}),
        Node("south_quad", "South Quad", n.DORM, p.HIGH, "central",
             demand=100, occupancy=1100, position={"x": 40, "y": 400}),

        # Medical campus. Kahn covers itself with on-site generators.
        Node("mott", "C.S. Mott Children's Hospital", n.HOSPITAL, p.CRITICAL, "medical",
             demand=190, occupancy=420, position={"x": 860, "y": 280}),
        Node("kahn", "Kahn Health Care Pavilion", n.HOSPITAL, p.HIGH, "medical",
             demand=150, local_supply=150, occupancy=300, position={"x": 1060, "y": 180}),

        # North campus, bought from DTE
        Node("beyster", "Beyster Building", n.ACADEMIC, p.HIGH, "north",
             demand=100, occupancy=450, position={"x": 1180, "y": 220}),
        Node("duderstadt", "Duderstadt Center", n.LIBRARY, p.LOW, "north",
             demand=40, occupancy=300, position={"x": 1400, "y": 120}),
        Node("pierpont", "Pierpont Commons", n.DINING, p.MEDIUM, "north",
             demand=35, occupancy=250, position={"x": 1180, "y": 400}),
        Node("bursley", "Bursley Hall", n.DORM, p.HIGH, "north",
             demand=120, occupancy=1300, position={"x": 980, "y": 400}),
        Node("gg_brown", "G.G. Brown Laboratories", n.ACADEMIC, p.MEDIUM, "north",
             demand=70, occupancy=350, position={"x": 1400, "y": 300}),
        Node("ncrc", "North Campus Research Complex", n.RESEARCH, p.MEDIUM, "north",
             demand=90, local_supply=50, occupancy=200, position={"x": 1400, "y": 480}),

        # City DTE customers. Each is its own small feeder.
        Node("city_hall", "Larcom City Hall", n.CIVIC, p.MEDIUM, "city_hall",
             demand=25, local_supply=40, occupancy=80, position={"x": 40, "y": 620}),
        Node("blake", "Blake Transit Center", n.TRANSIT, p.LOW, "blake",
             demand=10, local_supply=20, occupancy=60, position={"x": 240, "y": 640}),
        Node("fire_1", "Fire Station 1", n.CIVIC, p.HIGH, "fire_1",
             demand=15, local_supply=25, occupancy=18, position={"x": 440, "y": 640}),
    ]


def _build_edges() -> list[Edge]:
    e = EdgeType
    edges: list[Edge] = []

    def add(kind: EdgeType, src: str, dst: str) -> None:
        edges.append(Edge(f"{kind.value}:{src}->{dst}", src, dst, kind))

    for dst in ("angell", "shapiro", "union", "ross", "markley", "south_quad"):
        add(e.POWER, "cpp", dst)
    add(e.POWER, "cpp", "uh")  # emergency tie, not the hospital's main feed
    add(e.POWER, "uh", "mott")
    add(e.POWER, "uh", "kahn")
    for dst in ("beyster", "duderstadt", "pierpont", "bursley", "gg_brown", "ncrc"):
        add(e.POWER, "north_switch", dst)

    # Central campus streets
    add(e.ROAD, "union", "angell")
    add(e.ROAD, "angell", "shapiro")
    add(e.ROAD, "shapiro", "ross")
    add(e.ROAD, "ross", "south_quad")
    add(e.ROAD, "union", "south_quad")
    add(e.ROAD, "angell", "cpp")
    add(e.ROAD, "cpp", "markley")
    # Fuller / Glen, between the Hill and the hospital
    add(e.ROAD, "markley", "uh")
    add(e.ROAD, "cpp", "uh")
    add(e.ROAD, "uh", "mott")
    add(e.ROAD, "uh", "kahn")
    add(e.ROAD, "mott", "kahn")
    # Downtown
    add(e.ROAD, "union", "blake")
    add(e.ROAD, "blake", "city_hall")
    add(e.ROAD, "blake", "fire_1")
    # North campus
    add(e.ROAD, "north_switch", "beyster")
    add(e.ROAD, "beyster", "duderstadt")
    add(e.ROAD, "beyster", "pierpont")
    add(e.ROAD, "beyster", "gg_brown")
    add(e.ROAD, "pierpont", "bursley")
    add(e.ROAD, "gg_brown", "ncrc")
    add(e.ROAD, "north_switch", "ncrc")
    # TheRide: north campus to downtown
    add(e.ROAD, "pierpont", "blake")
    return edges


class CampusGraph:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.nodes: dict[str, Node] = {n.id: n for n in _build_nodes()}
        self.edges: list[Edge] = _build_edges()
        self.tick_count: int = 0
        self.last_tick: TickResult | None = None
        self.proposals: dict[str, dict[str, Any]] = {}
        assert len(self.nodes) == 20, "expected the 20 approved Ann Arbor places"
        for node in self.nodes.values():
            node.baseline_occupancy = node.occupancy
        self.tick()

    def get(self, node_id: str) -> Node:
        try:
            return self.nodes[node_id]
        except KeyError:
            raise KeyError(f"Unknown node id '{node_id}'") from None

    def fail_node(self, node_id: str) -> Node:
        node = self.get(node_id)
        node.failed = True
        return node

    def add_proposal(self, node: Node, meta: dict[str, Any], power_from: str, road_to: str) -> Node:
        """A planner's building. It joins one existing feed and one existing road."""
        self.nodes[node.id] = node
        self.edges.append(Edge(f"power:{power_from}->{node.id}", power_from, node.id, EdgeType.POWER))
        self.edges.append(Edge(f"road:{road_to}->{node.id}", road_to, node.id, EdgeType.ROAD))
        self.proposals[node.id] = meta
        node.baseline_occupancy = node.occupancy
        return node

    def remove_proposal(self, node_id: str) -> None:
        self.proposals.pop(node_id, None)
        self.nodes.pop(node_id, None)
        self.edges = [edge for edge in self.edges if edge.source != node_id and edge.target != node_id]

    def restore_node(self, node_id: str) -> Node:
        node = self.get(node_id)
        node.failed = False
        return node

    def set_load_shed(self, node_id: str, fraction: float) -> Node:
        node = self.get(node_id)
        node.load_shed = max(0.0, min(1.0, fraction))
        return node

    def tick(self) -> TickResult:
        self.tick_count += 1
        feeders = sorted({n.feeder for n in self.nodes.values()})
        supply_total = 0.0
        demand_total = 0.0

        for feeder in feeders:
            group = [n for n in self.nodes.values() if n.feeder == feeder]
            supply = supply_for(self.nodes, feeder)
            consumers = [n for n in group if not n.is_supplier]
            demand = sum(n.effective_demand for n in consumers)
            ratio = 1.0 if demand <= 0 else min(1.0, supply / demand)
            supply_total += supply
            demand_total += demand

            for node in group:
                if node.is_supplier:
                    node.current_power = 0.0 if node.failed else round(min(node.capacity, max(demand, 0.0)), 2)
                    node.status = Status.RED if node.failed else Status.GREEN
                elif node.failed:
                    node.current_power = 0.0
                    node.status = Status.RED
                else:
                    node.current_power = round(node.effective_demand * ratio, 2)
                    node.status = _status_for_ratio(node.power_ratio)

        deficit = max(0.0, demand_total - supply_total)
        counts = {s.value: 0 for s in Status}
        for node in self.nodes.values():
            counts[node.status.value] += 1

        self.last_tick = TickResult(
            tick=self.tick_count,
            supply=round(supply_total, 2),
            demand=round(demand_total, 2),
            deficit=round(deficit, 2),
            power_ratio=round(1.0 if demand_total <= 0 else min(1.0, supply_total / demand_total), 4),
            failed_nodes=sorted(n.id for n in self.nodes.values() if n.failed),
            status_counts=counts,
        )
        return self.last_tick

    def to_dict(self) -> dict[str, Any]:
        return {
            "tick": self.tick_count,
            "summary": asdict(self.last_tick) if self.last_tick else None,
            "nodes": [_node_to_dict(n) for n in self.nodes.values()],
            "edges": [asdict(e) for e in self.edges],
        }


def _status_for_ratio(ratio: float) -> Status:
    if ratio >= GREEN_THRESHOLD:
        return Status.GREEN
    if ratio >= AMBER_THRESHOLD:
        return Status.AMBER
    return Status.RED


def _node_to_dict(n: Node) -> dict[str, Any]:
    data = asdict(n)
    data["type"] = n.type.value
    data["priority"] = n.priority.name.lower()
    data["status"] = n.status.value
    data["power_ratio"] = round(n.power_ratio, 4)
    return data


if __name__ == "__main__":
    graph = CampusGraph()
    print("initial:", graph.last_tick)
    graph.fail_node("cpp")
    print("cpp down:", graph.tick())
