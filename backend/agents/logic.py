"""
Agent decision functions. Pure and deterministic: the simulation loop and the
uAgents in `serve.py` both call these, so behaviour does not depend on which
process is driving the tick.

Energy  - in a deficit, shed lowest priority first and never touch Critical.
Transit - a Red node with people sends them to the nearest Green node by road,
          never into a feed or a hospital. Hospitals, and buildings closed
          roads cut off, shelter in place.
Coordinator - applies a parsed policy (fail / restore / reset) from voice.
"""

from __future__ import annotations

from collections import deque

from graph import MEDICAL_TIE, CampusGraph, EdgeType, NodeType, Priority, Status, supply_for

# Spoken names the keyword parser and the language model both might use.
ALIASES: dict[str, str] = {
    "central power plant": "cpp",
    "power plant": "cpp",
    "north campus switching station": "north_switch",
    "switching station": "north_switch",
    "north campus": "north_switch",
    "university hospital": "uh",
    "hospital": "uh",
    "mott children's": "mott",
    "mott": "mott",
    "kahn pavilion": "kahn",
    "kahn": "kahn",
    "angell hall": "angell",
    "angell": "angell",
    "shapiro": "shapiro",
    "undergraduate library": "shapiro",
    "michigan union": "union",
    "union": "union",
    "ross": "ross",
    "markley": "markley",
    "south quad": "south_quad",
    "beyster": "beyster",
    "duderstadt": "duderstadt",
    "pierpont": "pierpont",
    "bursley": "bursley",
    "g.g. brown": "gg_brown",
    "gg brown": "gg_brown",
    "brown laboratories": "gg_brown",
    "research complex": "ncrc",
    "ncrc": "ncrc",
    "city hall": "city_hall",
    "larcom": "city_hall",
    "blake": "blake",
    "transit center": "blake",
    "fire station": "fire_1",
}


# Response policies the energy agent can run. Branch Timeline compares them.
STRATEGIES: dict[str, dict[str, str]] = {
    "tiered": {
        "label": "Priority tiers",
        "description": "Shed the lowest priority tier first. Critical care is never shed.",
    },
    "residential": {
        "label": "Protect residential",
        "description": "Keep dorms powered. Academic and commons buildings go dark first.",
    },
    "academic": {
        "label": "Protect classes",
        "description": "Keep classrooms and libraries powered. Residence halls go dark first.",
    },
    "people": {
        "label": "Most people per kW",
        "description": "Shed the buildings that serve the fewest people per kilowatt first.",
    },
    "even": {
        "label": "Ration evenly",
        "description": "No load shedding. Every building on the feed gets the same share.",
    },
}
DEFAULT_STRATEGY = "tiered"
# Feeds have no room for people, and hospitals keep their beds for patients.
NO_EVACUEES = (NodeType.SUBSTATION, NodeType.HOSPITAL)


def _shed_order(consumers: list, strategy: str) -> list:
    """Non-critical consumers in the order the strategy sheds them."""
    pool = [n for n in consumers if n.priority != Priority.CRITICAL]
    if strategy == "even":
        return []
    if strategy == "residential":
        return sorted(pool, key=lambda n: (n.type == NodeType.DORM, -n.priority.value, -n.demand, n.id))
    if strategy == "academic":
        keep = (NodeType.ACADEMIC, NodeType.LIBRARY)
        return sorted(pool, key=lambda n: (n.type in keep, -n.priority.value, -n.demand, n.id))
    if strategy == "people":
        return sorted(pool, key=lambda n: (n.occupancy / n.demand if n.demand > 0 else 0.0, n.id))
    return sorted(pool, key=lambda n: (-n.priority.value, -n.demand, n.id))


def apply_energy(graph: CampusGraph, strategy: str = DEFAULT_STRATEGY) -> list[str]:
    """
    Per feeder: shed in the order the strategy sets and never touch Critical.
    A deficit on north campus does not shed central campus.
    """
    before = {n.id: round(n.load_shed, 4) for n in graph.nodes.values()}
    plan: dict[str, float] = {n.id: 0.0 for n in graph.nodes.values()}
    notes: list[str] = []
    feeders = sorted({n.feeder for n in graph.nodes.values()})

    for feeder in feeders:
        consumers = [
            n for n in graph.nodes.values()
            if n.feeder == feeder and not n.is_supplier and not n.failed
        ]
        supply = supply_for(graph.nodes, feeder, graph.cut_edges)
        deficit = max(0.0, sum(n.demand for n in consumers) - supply)
        order = _shed_order(consumers, strategy)
        remaining = deficit
        for node in order:
            if remaining <= 1e-6 or node.demand <= 0:
                plan[node.id] = 0.0
                continue
            if node.demand <= remaining + 1e-6:
                plan[node.id] = 1.0
                remaining -= node.demand
            else:
                plan[node.id] = remaining / node.demand
                remaining = 0.0

        changed = any(round(plan[n.id], 4) != before[n.id] for n in order)
        if not changed or deficit <= 0:
            continue
        parts: list[str] = []
        for node in order:
            shed = plan[node.id]
            if shed >= 0.999:
                parts.append(f"{node.name} off")
            elif shed > 0.01:
                parts.append(f"{node.name} -{round(shed * 100)}%")
        detail = ", ".join(parts) if parts else "nothing left to shed"
        notes.append(f"Energy agent ({feeder}): {deficit:.0f} kW short, shed {detail}")

    for node in graph.nodes.values():
        if node.is_supplier or node.failed or node.priority == Priority.CRITICAL:
            node.load_shed = 0.0
        else:
            node.load_shed = plan.get(node.id, 0.0)

    after = {n.id: round(n.load_shed, 4) for n in graph.nodes.values()}
    if after == before:
        return []
    if not notes:
        return ["Energy agent: load shed cleared"]
    return notes


def apply_transit(graph: CampusGraph) -> list[str]:
    """
    Move everyone out of Red nodes to the nearest Green node along open roads.
    Hospitals keep their patients and take in nobody else; people the closed
    roads cut off stay put.
    Each building that shelters is logged once, not every tick.
    """
    adj = _roads(graph)
    notes: list[str] = []
    told = getattr(graph, "sheltering", set())
    sheltering: set[str] = set()
    reds = sorted(
        (n for n in graph.nodes.values() if n.status == Status.RED and n.occupancy > 0),
        key=lambda n: n.id,
    )
    for src in reds:
        if src.type == NodeType.HOSPITAL:
            sheltering.add(src.id)
            if src.id not in told:
                notes.append(f"Transit agent: {src.name} shelters in place on backup power, {src.occupancy} people stay")
            continue
        dest_id = _nearest_green(graph, src.id, adj)
        if dest_id is None:
            sheltering.add(src.id)
            if src.id not in told:
                why = "roads closed" if cut_off_by_roads(graph, src.id) else "no Green node in reach"
                notes.append(f"Transit agent: {src.occupancy} people sheltering in place at {src.name}; {why}")
            continue
        dest = graph.nodes[dest_id]
        moved = src.occupancy
        dest.occupancy += moved
        src.occupancy = 0
        notes.append(f"Transit agent: moved {moved} from {src.name} to {dest.name}")
    graph.sheltering = sheltering
    return notes


def cut_off_by_roads(graph: CampusGraph, node_id: str) -> bool:
    """A lit building would be in reach if the closed roads were open."""
    return _nearest_green(graph, node_id, _roads(graph, open_only=False)) is not None


def apply_policy(graph: CampusGraph, policy: dict) -> list[str]:
    """Apply a coordinator policy. Does not tick; the caller runs a cycle after."""
    action = str(policy.get("action") or "none")
    reason = str(policy.get("reason") or policy.get("summary") or "").strip()
    if action == "reset":
        graph.reset()
        return [f"Coordinator: campus reset. {reason}".strip()]
    if action == "heat_wave":
        from agents import runtime as agent_runtime

        agent_runtime.paused = False
        agent_runtime.forget_after(graph.tick_count)
        agent_runtime.begin_scenario("Heat wave, 95°F")
        graph.start_heat_wave()
        return ["Coordinator: heat wave, 95°F. Plant output falls over the next 4 hours."]
    if action == "none":
        summary = str(policy.get("summary") or "no grid action")
        return [f"Coordinator: {summary}"]

    ids = resolve_nodes(graph, policy.get("node_ids") or [])
    if not ids:
        return [f"Coordinator: could not match a campus node in '{reason or policy}'"]
    for nid in ids:
        if action == "restore":
            graph.restore_node(nid)
        else:
            graph.fail_node(nid)
    names = ", ".join(graph.nodes[i].name for i in ids)
    verb = "restored" if action == "restore" else "failed"
    tail = f" ({reason})" if reason else ""
    notes = [f"Coordinator: {verb} {names}{tail}"]
    if action == "restore":
        notes += _still_cut(graph, ids)
    return notes


def _still_cut(graph: CampusGraph, ids: list[str]) -> list[str]:
    """Power lines out of a restored building stay cut until the building they feed is restored too."""
    notes = []
    for mark in getattr(graph, "cut_edges", []):
        _, _, ends = mark["id"].partition(":")
        src, _, dst = ends.partition("->")
        if src in ids and dst in graph.nodes and src in graph.nodes:
            far = graph.nodes[dst].name
            line = "emergency tie" if mark["id"] == MEDICAL_TIE else "line"
            notes.append(f"Coordinator: the {line} from {graph.nodes[src].name} to {far} is still cut. Restore {far} to repair it")
    return notes[:3]


def resolve_nodes(graph: CampusGraph, raw_ids: list) -> list[str]:
    found: list[str] = []
    for raw in raw_ids:
        text = str(raw).strip().lower()
        if text in graph.nodes and text not in found:
            found.append(text)
            continue
        alias = ALIASES.get(text)
        if alias and alias not in found:
            found.append(alias)
            continue
        for node in graph.nodes.values():
            if text == node.name.lower() and node.id not in found:
                found.append(node.id)
                break
    return found


def keyword_policy(text: str) -> dict:
    """
    Deterministic fallback when Gemini is not configured or the call fails.
    Matches campus names in the utterance.
    """
    t = text.lower()
    if any(phrase in t for phrase in (
        "reset", "restore everything", "restore the campus", "restore campus",
        "all clear", "back to normal",
    )):
        return {"action": "reset", "node_ids": [], "reason": text.strip(), "summary": "Reset the campus", "parser": "keyword"}

    if any(phrase in t for phrase in ("heat wave", "heatwave", "heat-wave", "simulate the heat", "start a heat")):
        return {
            "action": "heat_wave",
            "node_ids": [],
            "reason": text.strip(),
            "summary": "Start a four-hour heat wave",
            "parser": "keyword",
        }

    action = "restore" if any(word in t for word in ("restore", "bring back", "fix ", "repair")) else "fail"
    if any(phrase in t for phrase in ("grid collapse", "total blackout", "whole grid", "entire grid", "all three feeds")):
        ids = ["cpp", "uh", "north_switch"]
    else:
        ids = []
        # Longer aliases first so "south substation" wins over a bare "south".
        for alias, nid in sorted(ALIASES.items(), key=lambda kv: -len(kv[0])):
            if alias in t and nid not in ids:
                ids.append(nid)
    if not ids:
        return {
            "action": "none",
            "node_ids": [],
            "reason": text.strip(),
            "summary": "No campus node recognized",
            "parser": "keyword",
        }
    return {"action": action, "node_ids": ids, "reason": text.strip(), "summary": text.strip(), "parser": "keyword"}


def _roads(graph: CampusGraph, open_only: bool = True) -> dict[str, list[str]]:
    adj: dict[str, list[str]] = {n.id: [] for n in graph.nodes.values()}
    # Roads the weather or the director closed are not driven.
    closed = {m["id"] for m in getattr(graph, "closed_roads", [])} if open_only else set()
    for edge in graph.edges:
        if edge.type != EdgeType.ROAD or edge.id in closed:
            continue
        adj[edge.source].append(edge.target)
        adj[edge.target].append(edge.source)
    return adj


def _nearest_green(graph: CampusGraph, src: str, adj: dict[str, list[str]]) -> str | None:
    """
    Nearest lit building by road. Roads can pass a substation or a hospital, but
    nobody is sent into one. Only a building with no road at all falls back to distance.
    """
    seen = {src}
    queue: deque[str] = deque([src])
    while queue:
        cur = queue.popleft()
        for nxt in adj[cur]:
            if nxt in seen:
                continue
            seen.add(nxt)
            node = graph.nodes[nxt]
            if node.status == Status.GREEN and not node.failed and node.type not in NO_EVACUEES:
                return nxt
            queue.append(nxt)

    if any(e.type == EdgeType.ROAD and src in (e.source, e.target) for e in graph.edges):
        return None
    origin = graph.nodes[src]
    greens = [
        n for n in graph.nodes.values()
        if n.status == Status.GREEN and not n.failed and n.id != src and n.type not in NO_EVACUEES
    ]
    if not greens:
        return None
    ox, oy = origin.position.get("x", 0.0), origin.position.get("y", 0.0)
    greens.sort(key=lambda n: (n.position.get("x", 0) - ox) ** 2 + (n.position.get("y", 0) - oy) ** 2)
    return greens[0].id
