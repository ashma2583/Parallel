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

from agents.logic import apply_energy, apply_policy, apply_transit

TICK_SECONDS = 1.0

lock = threading.Lock()
activity: deque[str] = deque(maxlen=12)
revision = 0
last_cycle = 0.0
main_loop: asyncio.AbstractEventLoop | None = None
graph: CampusGraph | None = None
agent_status: dict[str, Any] = {"running": False, "address": {}}

policy_queue: deque = deque()


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
    notes.extend(apply_energy(sim))
    sim.tick()
    notes.extend(apply_transit(sim))
    if notes:
        push(notes)
    last_cycle = now
    return notes


def push(lines: list[str]) -> None:
    global revision
    activity.extend(lines)
    revision += 1


def snapshot() -> dict[str, Any]:
    return {"lines": list(activity), "agents": agent_status}
