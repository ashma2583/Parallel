"""
Shared simulation lock, activity log, and the one-second agent cycle.

The FastAPI loop and the FetchAI bureau both call `run_cycle`. A short
throttle keeps them from double-stepping; user actions pass force=True.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections import deque
from typing import Any

from graph import CampusGraph, Status, TickResult

from agents.logic import DEFAULT_STRATEGY, apply_energy, apply_policy, apply_transit

TICK_SECONDS = 1.0

lock = threading.Lock()
activity: deque[str] = deque(maxlen=12)
# Tick each activity line was logged on, kept in step with `activity`.
activity_ticks: deque[int] = deque(maxlen=12)
revision = 0
last_cycle = 0.0
main_loop: asyncio.AbstractEventLoop | None = None
graph: CampusGraph | None = None
agent_status: dict[str, Any] = {"running": False, "address": {}}
# summer opens cooling centers. fall, winter, and spring open warming centers.
season = "fall"
paused = False
# One saved campus per tick, so the clock can move backward.
frames: dict[int, dict[str, Any]] = {}

policy_queue: deque = deque()
# Response policy the energy agent is running. Set from Branch Timeline.
strategy = DEFAULT_STRATEGY


def bind(sim: CampusGraph, loop: asyncio.AbstractEventLoop, tick_seconds: float) -> None:
    global graph, main_loop, TICK_SECONDS
    graph = sim
    main_loop = loop
    TICK_SECONDS = tick_seconds


def run_cycle(sim: CampusGraph, *, force: bool = False) -> list[str]:
    """Energy, tick, then transit. Caller must hold `lock`."""
    global last_cycle
    now = time.monotonic()
    if not force and now - last_cycle < TICK_SECONDS * 0.85:
        return []
    notes: list[str] = []
    notes.extend(apply_energy(sim, strategy))
    sim.tick()
    notes.extend(apply_transit(sim))
    if notes:
        push(notes)
    remember(sim)
    last_cycle = now
    return notes


def remember(sim: CampusGraph) -> None:
    """Save this tick and drop any future that a new action replaced."""
    frames[sim.tick_count] = _capture(sim)
    for tick in [tick for tick in frames if tick > sim.tick_count]:
        del frames[tick]


def forget() -> None:
    frames.clear()


def forget_after(tick: int) -> None:
    for saved in [saved for saved in frames if saved > tick]:
        del frames[saved]


def recall(sim: CampusGraph, tick: int) -> bool:
    frame = frames.get(tick)
    if frame is None:
        return False
    sim.tick_count = frame["tick"]
    for node_id in list(sim.proposals):
        if node_id not in frame["nodes"]:
            sim.remove_proposal(node_id)
    for node_id, fields in frame["nodes"].items():
        node = sim.nodes.get(node_id)
        if node is None:
            continue
        node.current_power = fields["current_power"]
        node.occupancy = fields["occupancy"]
        node.status = Status(fields["status"])
        node.failed = fields["failed"]
        node.load_shed = fields["load_shed"]
    summary = frame["summary"]
    if summary:
        sim.last_tick = TickResult(
            tick=summary["tick"],
            supply=summary["supply"],
            demand=summary["demand"],
            deficit=summary["deficit"],
            power_ratio=summary["power_ratio"],
            failed_nodes=list(summary["failed_nodes"]),
            status_counts=dict(summary["status_counts"]),
        )
    return True


def _capture(sim: CampusGraph) -> dict[str, Any]:
    summary = None
    if sim.last_tick is not None:
        summary = {
            "tick": sim.last_tick.tick,
            "supply": sim.last_tick.supply,
            "demand": sim.last_tick.demand,
            "deficit": sim.last_tick.deficit,
            "power_ratio": sim.last_tick.power_ratio,
            "failed_nodes": list(sim.last_tick.failed_nodes),
            "status_counts": dict(sim.last_tick.status_counts),
        }
    return {
        "tick": sim.tick_count,
        "nodes": {
            node.id: {
                "current_power": node.current_power,
                "occupancy": node.occupancy,
                "status": node.status.value,
                "failed": node.failed,
                "load_shed": node.load_shed,
            }
            for node in sim.nodes.values()
        },
        "summary": summary,
    }


def push(lines: list[str]) -> None:
    global revision
    activity.extend(lines)
    activity_ticks.extend([graph.tick_count if graph else 0] * len(lines))
    revision += 1


def snapshot() -> dict[str, Any]:
    return {"lines": list(activity), "ticks": list(activity_ticks), "agents": agent_status, "strategy": strategy}
