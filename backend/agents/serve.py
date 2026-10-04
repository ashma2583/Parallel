"""
FetchAI bureau. Three uAgents share one local server on port 8110.

The energy agent owns the one-second cycle (shed, tick, evacuate) and tells
the transit and coordinator agents what it did. The coordinator agent is the
only one that applies voice policies: it drains a queue the HTTP handler fills.

Run on its own with `python -m agents.serve` only when FastAPI is not already
starting this bureau (it does, on startup).
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import threading

from uagents import Agent, Bureau, Context, Model

from agents import runtime

log = logging.getLogger("parallel.agents")

BUREAU_PORT = int(os.getenv("AGENTS_PORT", "8110"))


def _free_port(start: int, tries: int = 10) -> int | None:
    """The first port from `start` nobody is listening on. Another engine may hold the default."""
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("0.0.0.0", port))
            except OSError:
                continue
            return port
    return None


class CycleReport(Model):
    tick: int
    notes: str


class PolicyDirective(Model):
    summary: str


def start_in_thread() -> threading.Thread | None:
    global BUREAU_PORT
    port = _free_port(BUREAU_PORT)
    if port is None:
        log.warning("FetchAI bureau not started: ports %s-%s are busy", BUREAU_PORT, BUREAU_PORT + 9)
        runtime.agent_status["running"] = False
        return None
    BUREAU_PORT = port
    thread = threading.Thread(target=_run, name="fetchai-bureau", daemon=True)
    thread.start()
    return thread


def _run() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        energy = Agent(
            name="energy",
            seed="parallel energy agent seed",
            mailbox=False,
            loop=loop,
            port=BUREAU_PORT,
        )
        transit = Agent(
            name="transit",
            seed="parallel transit agent seed",
            mailbox=False,
            loop=loop,
        )
        coordinator = Agent(
            name="coordinator",
            seed="parallel coordinator agent seed",
            mailbox=False,
            loop=loop,
        )

        seen = {"revision": -1}

        @energy.on_interval(period=runtime.TICK_SECONDS)
        async def energy_cycle(ctx: Context) -> None:
            # The simulation loop owns the clock. This agent reports what the
            # cycle just did so transit and the coordinator stay in the protocol.
            sim = runtime.graph
            if sim is None:
                return
            with runtime.lock:
                if runtime.revision == seen["revision"]:
                    return
                seen["revision"] = runtime.revision
                tick = sim.tick_count
                text = " | ".join(list(runtime.activity)[-3:]) or "nominal"
            await ctx.send(transit.address, CycleReport(tick=tick, notes=text))
            await ctx.send(coordinator.address, CycleReport(tick=tick, notes=text))

        @transit.on_message(model=CycleReport)
        async def transit_review(ctx: Context, sender: str, msg: CycleReport) -> None:
            ctx.logger.info("tick %s from %s: %s", msg.tick, sender, msg.notes)

        @coordinator.on_message(model=CycleReport)
        async def coordinator_review(ctx: Context, sender: str, msg: CycleReport) -> None:
            if msg.notes != "nominal":
                ctx.logger.info("ack tick %s: %s", msg.tick, msg.notes)

        @coordinator.on_interval(period=0.25)
        async def drain_policies(ctx: Context) -> None:
            while True:
                sim = runtime.graph
                with runtime.lock:
                    if sim is None or not runtime.policy_queue:
                        return
                    policy, box, event = runtime.policy_queue.popleft()
                    if box.get("done"):
                        event.set()
                        continue
                    notes = runtime.apply_order(sim, policy)
                    box["notes"] = notes
                    box["done"] = True
                    tick = sim.tick_count
                event.set()
                await ctx.send(energy.address, CycleReport(tick=tick, notes=" | ".join(notes)))

        runtime.agent_status = {
            "running": True,
            "address": {
                "energy": energy.address,
                "transit": transit.address,
                "coordinator": coordinator.address,
            },
        }
        log.info("FetchAI bureau listening on %s", BUREAU_PORT)
        Bureau(agents=[energy, transit, coordinator], port=BUREAU_PORT, loop=loop).run()
    except BaseException:
        # A bind error inside the bureau can raise SystemExit; never let it reach the engine.
        log.exception("FetchAI bureau stopped")
        runtime.agent_status["running"] = False
