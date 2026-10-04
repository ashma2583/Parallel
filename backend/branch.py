"""
Branch Timeline. Fork the live graph, run each response policy forward on its
own copy, and report what happened. Same agent functions as the live cycle,
so a branch shows exactly what adopting that policy would do.

A branch can also play a planned scenario forward: timed batches of hits, the
same shapes /storms/hit takes, land on the copy at their tick while the policy
runs. The live campus and its feed are untouched.
"""

from __future__ import annotations

import copy
from typing import Any

from pydantic import BaseModel, Field

import storms
from agents.logic import STRATEGIES, apply_energy, apply_transit
from briefing import _is_shelter
import savings
from graph import HEAT_WAVE_SPAN, CampusGraph, Priority, Status, _node_to_dict
from hazards import EFFECTS

HEAT = "extreme_heat"
# Ticks the copy keeps running after the last hit, so the agents settle.
SETTLE_TICKS = 6


class ScenarioBatch(BaseModel):
    """What lands on the copy at one tick, counted from the fork."""

    tick: int = Field(..., ge=0, le=900)
    # A campus condition, applied the way /hazards/apply does. Extreme heat starts the four-hour ramp.
    hazard: str | None = Field(None, max_length=40, examples=["extreme_cold"])
    fail: list[str] = Field(default_factory=list)
    derate: list[storms.Derate] = Field(default_factory=list)
    cut_edges: list[storms.EdgeMark] = Field(default_factory=list)
    close_roads: list[storms.EdgeMark] = Field(default_factory=list)
    close_routes: list[storms.ClosedRoute] = Field(default_factory=list)


def scenario_ticks(graph: CampusGraph, scenario: list[ScenarioBatch], ticks: int) -> tuple[int, bool]:
    """
    How far to run a planned scenario: past its last hit by SETTLE_TICKS, and to
    the peak of any heat wave it starts or one already building. True when the
    heat peak is what set the length.
    """
    end = max(ticks, max(b.tick for b in scenario) + SETTLE_TICKS)
    peak = max((b.tick + HEAT_WAVE_SPAN for b in scenario if b.hazard == HEAT), default=0)
    wave = graph.heat_wave
    if wave and wave["step"] < wave["span"]:
        peak = max(peak, wave["span"] - wave["step"])
    return max(end, peak), peak > end


def run_branches(
    graph: CampusGraph,
    strategy_ids: list[str],
    ticks: int,
    season: str = "fall",
    *,
    cooling: bool | None = None,
    scenario: list[ScenarioBatch] | None = None,
) -> list[dict[str, Any]]:
    use_cooling = season == "summer" if cooling is None else cooling
    return [_run(graph, sid, ticks, use_cooling, scenario or []) for sid in strategy_ids]


def _run(
    graph: CampusGraph,
    strategy: str,
    ticks: int,
    cooling: bool = False,
    scenario: list[ScenarioBatch] | None = None,
) -> dict[str, Any]:
    sim = copy.deepcopy(graph)
    if scenario:
        _scenario_start(sim)
    # Every branch starts with people at home, so the policies are compared on
    # the same footing whatever the live transit agent has already done.
    sim.send_home()
    start = {n.id: n.occupancy for n in sim.nodes.values()}
    log: list[str] = []
    for tick in range(ticks):
        for batch in scenario or []:
            if batch.tick == tick:
                _land(sim, batch)
        log.extend(sim.advance_heat_wave())
        log.extend(savings.advance(sim))
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
    wanted = sum(n.allowed_demand for n in nodes)
    if wanted <= 0:
        return 1.0
    return round(sum(n.current_power for n in nodes) / wanted, 4)


def _scenario_start(sim: CampusGraph) -> None:
    """
    The campus a scenario run starts from. After a first run that is the saved
    starting state, with the director's setup since carried over, exactly as
    /storms/scenario/run puts it back on the live campus.
    """
    baseline = getattr(sim, "scenario_baseline", None)
    if baseline is None:
        return
    setup = storms._setup(sim)
    storms._restore(sim, baseline)
    storms._keep_setup(sim, setup)


def _land(sim: CampusGraph, batch: ScenarioBatch) -> None:
    """One batch on the copy: a campus condition, then the storm hits. Nothing is logged to the live feed."""
    if batch.hazard == HEAT:
        sim.start_heat_wave()
    elif batch.hazard:
        effect = EFFECTS.get(batch.hazard) or {}
        for step in effect.get("steps", []):
            for nid in step["node_ids"]:
                if nid not in sim.nodes:
                    continue
                if step["action"] == "fail":
                    sim.fail_node(nid)
                else:
                    sim.derate_node(nid, min(sim.nodes[nid].derate, step["factor"]))
    storms.apply_hit(sim, storms.HitRequest(
        storm_id="branch",
        fail=batch.fail,
        derate=batch.derate,
        cut_edges=batch.cut_edges,
        close_roads=batch.close_roads,
        close_routes=batch.close_routes,
    ))
