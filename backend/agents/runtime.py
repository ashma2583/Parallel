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

from graph import CampusGraph

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
    last_cycle = now
    return notes


def fresh_start() -> None:
    """After a campus reset: the default policy and an empty feed. Caller holds `lock`."""
    global strategy
    strategy = DEFAULT_STRATEGY
    activity.clear()
    activity_ticks.clear()


def apply_order(sim: CampusGraph, policy: dict) -> list[str]:
    """
    Apply a coordinator policy, log it, and run a cycle. A spoken or typed reset
    ends like the Reset button: default policy, feed started afresh. Caller holds `lock`.
    """
    notes = apply_policy(sim, policy)
    if policy.get("action") == "reset":
        fresh_start()
    push(notes)
    run_cycle(sim, force=True)
    return notes


def push(lines: list[str]) -> None:
    global revision
    activity.extend(lines)
    activity_ticks.extend([graph.tick_count if graph else 0] * len(lines))
    revision += 1


def snapshot() -> dict[str, Any]:
    return {"lines": list(activity), "ticks": list(activity_ticks), "agents": agent_status, "strategy": strategy}
