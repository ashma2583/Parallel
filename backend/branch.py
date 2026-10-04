"""
Branch Timeline. Fork the live graph, run each response policy forward on its
own copy, and report what happened. Same agent functions as the live cycle,
so a branch shows exactly what adopting that policy would do.
"""

from __future__ import annotations

import copy
from typing import Any

from agents.logic import STRATEGIES, apply_energy, apply_transit
from briefing import _is_shelter
from graph import CampusGraph, Priority, Status, _node_to_dict


def run_branches(
    graph: CampusGraph,
    strategy_ids: list[str],
    ticks: int,
    season: str = "fall",
    *,
    cooling: bool | None = None,
) -> list[dict[str, Any]]:
    use_cooling = season == "summer" if cooling is None else cooling
    return [_run(graph, sid, ticks, use_cooling) for sid in strategy_ids]


def _run(graph: CampusGraph, strategy: str, ticks: int, cooling: bool = False) -> dict[str, Any]:
    sim = copy.deepcopy(graph)
    # Every branch starts with people at home, so the policies are compared on
    # the same footing whatever the live transit agent has already done.
    sim.send_home()
    start = {n.id: n.occupancy for n in sim.nodes.values()}
    log: list[str] = []
    for _ in range(ticks):
        log.extend(sim.advance_heat_wave())
        log.extend(apply_energy(sim, strategy))
        sim.tick()
        log.extend(apply_transit(sim))

    consumers = [n for n in sim.nodes.values() if not n.is_supplier]
    essential = [n for n in consumers if n.priority in (Priority.CRITICAL, Priority.HIGH)]
    critical = [n for n in consumers if n.priority == Priority.CRITICAL]
    people = sum(n.occupancy for n in sim.nodes.values())
    shelters = [n for n in sim.nodes.values() if _is_shelter(n, cooling) and n.status != Status.RED and not n.failed]

    return {
        "id": strategy,
        **STRATEGIES[strategy],
        "metrics": {
            "essential_served": _served(essential),
            "critical_served": _served(critical),
            "total_served": _served(consumers),
            "people_total": people,
            "people_full_power": sum(n.occupancy for n in sim.nodes.values() if n.status == Status.GREEN),
            "people_reduced_power": sum(n.occupancy for n in sim.nodes.values() if n.status == Status.AMBER),
            "people_dark": sum(n.occupancy for n in sim.nodes.values() if n.status == Status.RED),
            "people_relocated": sum(max(0, start[n.id] - n.occupancy) for n in sim.nodes.values()),
            "people_in_shelter": sum(n.occupancy for n in shelters),
            "shelter_kw": round(sum(n.current_power for n in shelters)),
            "buildings_dark": sum(1 for n in consumers if n.status == Status.RED),
            "status_counts": sim.last_tick.status_counts if sim.last_tick else {},
        },
        "nodes": [_node_to_dict(n) for n in sim.nodes.values()],
        "log": log,
    }


def _served(nodes: list) -> float:
    """Delivered kW over wanted kW. A failed building still counts as unserved demand."""
    wanted = sum(n.demand for n in nodes)
    if wanted <= 0:
        return 1.0
    return round(sum(n.current_power for n in nodes) / wanted, 4)
