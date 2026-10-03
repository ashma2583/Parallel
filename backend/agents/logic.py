"""
Agent decision functions. Pure and deterministic: the simulation loop and the
uAgents in `serve.py` both call these, so behaviour does not depend on which
process is driving the tick.

Energy  - in a deficit, shed lowest priority first and never touch Critical.
Transit - a Red node with people sends them to the nearest Green node by road.
Coordinator - applies a parsed policy (fail / restore / reset) from voice.
"""

from __future__ import annotations

from collections import deque

from graph import CampusGraph, EdgeType, NodeType, Priority, Status, supply_for

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
        supply = supply_for(graph.nodes, feeder)
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
    """Move everyone out of Red nodes to the nearest Green node along roads."""
    adj = _roads(graph)
    notes: list[str] = []
    reds = sorted(
        (n for n in graph.nodes.values() if n.status == Status.RED and n.occupancy > 0),
        key=lambda n: n.id,
    )
    for src in reds:
        dest_id = _nearest_green(graph, src.id, adj)
        if dest_id is None:
            notes.append(f"Transit agent: {src.occupancy} people stuck at {src.name}; no Green node")
            continue
        dest = graph.nodes[dest_id]
        moved = src.occupancy
        dest.occupancy += moved
        src.occupancy = 0
        notes.append(f"Transit agent: moved {moved} from {src.name} to {dest.name}")
    return notes


def apply_policy(graph: CampusGraph, policy: dict) -> list[str]:
    """Apply a coordinator policy. Does not tick; the caller runs a cycle after."""
    action = str(policy.get("action") or "none")
    reason = str(policy.get("reason") or policy.get("summary") or "").strip()
    if action == "reset":
        graph.reset()
        return [f"Coordinator: campus reset. {reason}".strip()]
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
    return [f"Coordinator: {verb} {names}{tail}"]


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


def _roads(graph: CampusGraph) -> dict[str, list[str]]:
    adj: dict[str, list[str]] = {n.id: [] for n in graph.nodes.values()}
    for edge in graph.edges:
        if edge.type != EdgeType.ROAD:
            continue
        adj[edge.source].append(edge.target)
        adj[edge.target].append(edge.source)
    return adj


def _nearest_green(graph: CampusGraph, src: str, adj: dict[str, list[str]]) -> str | None:
    seen = {src}
    queue: deque[str] = deque([src])
    while queue:
        cur = queue.popleft()
        for nxt in adj[cur]:
            if nxt in seen:
                continue
            seen.add(nxt)
            node = graph.nodes[nxt]
            if node.status == Status.GREEN and not node.failed:
                return nxt
            queue.append(nxt)

    origin = graph.nodes[src]
    greens = [
        n for n in graph.nodes.values()
        if n.status == Status.GREEN and not n.failed and n.id != src and n.type != NodeType.SUBSTATION
    ]
    if not greens:
        return None
    ox, oy = origin.position.get("x", 0.0), origin.position.get("y", 0.0)
    greens.sort(key=lambda n: (n.position.get("x", 0) - ox) ** 2 + (n.position.get("y", 0) - oy) ** 2)
    return greens[0].id
