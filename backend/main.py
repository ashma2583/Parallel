"""
PARALLEL - FastAPI backend.

Phase 1: Core engine. 15-node graph, deterministic tick, /state, /disrupt.
Phase 2: Publish the snapshot to SpacetimeDB about once a second.
Phase 4: Energy, Transit, and Coordinator agents run inside each cycle.
Phase 5: /voice transcribes with Grok Voice and parses a policy with Grok or Gemini.

Run from the `backend/` directory (with `spacetime start` running separately):
    uvicorn main:app --reload --port 8000

Environment (all optional):
    TICK_SECONDS    seconds between cycles, default "1.0"
    STDB_ENABLED    "0" to run without SpacetimeDB
    STDB_URL        default "http://127.0.0.1:3000"
    STDB_DATABASE   default "parallel"
    XAI_API_KEY     Grok Voice and Grok policy parsing
    POLICY_PARSER   auto (default) | grok | gemini | keyword
    GROK_MODEL      default "grok-4"
    GEMINI_API_KEY  optional; used first when POLICY_PARSER=auto
    GEMINI_MODEL    default "gemini-2.5-flash"
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
    load_dotenv(Path(__file__).resolve().parent / ".env.local")
except ImportError:
    pass

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from agents import runtime
import briefing
from agents.logic import DEFAULT_STRATEGY, STRATEGIES, apply_policy
from agents.serve import start_in_thread
from branch import run_branches
from graph import CampusGraph
from stdb import SpacetimePublisher
import voice

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("parallel")

TICK_SECONDS = float(os.getenv("TICK_SECONDS", "1.0"))

graph = CampusGraph()
publisher = SpacetimePublisher()


async def _sim_loop() -> None:
    """Publish every cycle. Drive the cycle too if the agent bureau is behind."""
    log.info(
        "sim loop started: every %.2fs, SpacetimeDB %s, xAI %s, policy %s",
        TICK_SECONDS,
        "on" if publisher.enabled else "off",
        "on" if voice.xai_configured() else "off",
        voice.policy_parser(),
    )
    while True:
        started = asyncio.get_running_loop().time()
        with runtime.lock:
            runtime.run_cycle(graph, force=False)
        await publisher.publish(graph)
        elapsed = asyncio.get_running_loop().time() - started
        await asyncio.sleep(max(0.05, TICK_SECONDS - elapsed))


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.bind(graph, asyncio.get_running_loop(), TICK_SECONDS)
    await publisher.start()
    start_in_thread()
    task = asyncio.create_task(_sim_loop(), name="sim-loop")
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await publisher.close()


app = FastAPI(
    title="PARALLEL Simulation Engine",
    description="Campus digital twin: agent-driven tick loop over a 15-node graph.",
    version="0.6.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DisruptRequest(BaseModel):
    node_ids: list[str] = Field(..., min_length=1, examples=[["sub_south"]])
    action: Literal["fail", "restore", "derate"] = Field("fail")
    factor: float = Field(0.5, ge=0.0, le=1.0, description="Output fraction for action=derate")
    reason: str | None = Field(None, examples=["Ice storm knocked out the south substation"])


class BranchRequest(BaseModel):
    ticks: int = Field(6, ge=1, le=60)
    strategies: list[str] | None = Field(None, examples=[["tiered", "residential"]])


class StrategyRequest(BaseModel):
    strategy: str = Field(..., examples=["residential"])


class PriorityRequest(BaseModel):
    mode: Literal["balanced", "dorms", "academic"]


# The first briefing build named these modes. Each is one of the strategies.
PRIORITY_STRATEGY = {"balanced": "tiered", "dorms": "residential", "academic": "academic"}


class CommandRequest(BaseModel):
    text: str = Field(..., min_length=1, examples=["The south substation just failed"])


def _state() -> dict:
    body = graph.to_dict()
    body["activity"] = list(runtime.activity)
    body["strategy"] = runtime.strategy
    return body


async def _settle_policy(policy: dict) -> list[str]:
    """Hand the policy to the coordinator agent, and apply it here if the agent is slow."""
    box: dict = {}
    event = threading.Event()
    with runtime.lock:
        runtime.policy_queue.append((policy, box, event))
    await asyncio.to_thread(event.wait, 2.0)
    if not box.get("done"):
        with runtime.lock:
            if not box.get("done"):
                runtime.policy_queue = deque(
                    item for item in runtime.policy_queue if item[1] is not box
                )
                notes = apply_policy(graph, policy)
                runtime.push(notes)
                runtime.run_cycle(graph, force=True)
                box["notes"] = notes
                box["done"] = True
    await publisher.publish(graph)
    return list(box.get("notes") or [])


@app.get("/")
def root() -> dict:
    return {
        "service": "PARALLEL",
        "phase": 6,
        "tick": graph.tick_count,
        "tick_seconds": TICK_SECONDS,
        "spacetimedb": publisher.status(),
        "agents": runtime.agent_status,
        "xai": voice.xai_configured(),
        "policy_parser": voice.policy_parser(),
    }


@app.get("/state")
def get_state() -> dict:
    with runtime.lock:
        return _state()


@app.get("/activity")
def get_activity() -> dict:
    return runtime.snapshot()


@app.get("/bus-routes")
def get_bus_routes() -> dict:
    return briefing.route_collection()


@app.get("/briefing")
def get_briefing() -> dict:
    with runtime.lock:
        return briefing.build_briefing(graph, runtime.strategy)


@app.post("/priority")
async def post_priority(req: PriorityRequest) -> dict:
    """Older name for /strategy. Returns the briefing for the new policy."""
    await post_strategy(StrategyRequest(strategy=PRIORITY_STRATEGY[req.mode]))
    with runtime.lock:
        return briefing.build_briefing(graph, runtime.strategy)


@app.post("/tick")
async def post_tick() -> dict:
    with runtime.lock:
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.publish(graph)
    return body


@app.post("/disrupt")
async def post_disrupt(req: DisruptRequest) -> dict:
    unknown = [nid for nid in req.node_ids if nid not in graph.nodes]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Unknown node id(s): {unknown}")
    with runtime.lock:
        for nid in req.node_ids:
            if req.action == "fail":
                graph.fail_node(nid)
            elif req.action == "derate":
                graph.derate_node(nid, req.factor)
            else:
                graph.restore_node(nid)
        verb = f"derate to {req.factor:.0%}" if req.action == "derate" else req.action
        runtime.push([
            f"Director: {verb} {', '.join(req.node_ids)}"
            + (f" ({req.reason})" if req.reason else "")
        ])
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.publish(graph)
    return {"disruption": {"action": req.action, "node_ids": req.node_ids, "reason": req.reason}, **body}


@app.post("/reset")
async def post_reset() -> dict:
    with runtime.lock:
        graph.reset()
        runtime.strategy = DEFAULT_STRATEGY
        runtime.push(["Director: campus reset"])
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.clear()
    await publisher.publish(graph)
    return body


@app.post("/branch")
def post_branch(req: BranchRequest) -> dict:
    """Fork the live state and run each response policy forward. The live sim is untouched."""
    ids = req.strategies or list(STRATEGIES)
    unknown = [sid for sid in ids if sid not in STRATEGIES]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Unknown strategy id(s): {unknown}")
    with runtime.lock:
        branches = run_branches(graph, ids, req.ticks)
        return {
            "base_tick": graph.tick_count,
            "ticks": req.ticks,
            "active": runtime.strategy,
            "branches": branches,
        }


@app.post("/strategy")
async def post_strategy(req: StrategyRequest) -> dict:
    """Adopt a response policy on the live simulation."""
    if req.strategy not in STRATEGIES:
        raise HTTPException(status_code=404, detail=f"Unknown strategy id: {req.strategy}")
    with runtime.lock:
        runtime.strategy = req.strategy
        graph.send_home()
        runtime.push([f"Coordinator: adopted policy '{STRATEGIES[req.strategy]['label']}'"])
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.publish(graph)
    return body


@app.post("/command")
async def post_command(req: CommandRequest) -> dict:
    """Parse a typed order and hand it to the coordinator. Used by the mic flow too."""
    policy = await voice.parse_policy(graph, req.text.strip())
    notes = await _settle_policy(policy)
    with runtime.lock:
        body = _state()
    return {"transcript": req.text.strip(), "policy": policy, "notes": notes, **body}


@app.post("/voice")
async def post_voice(file: UploadFile) -> dict:
    """Transcribe a push-to-talk clip, parse it, and apply the policy."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="empty audio")
    if len(audio) > 8_000_000:
        raise HTTPException(status_code=413, detail="audio longer than 8 MB")
    try:
        transcript = await voice.transcribe(audio, file.filename or "speech.webm", file.content_type or "audio/webm")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    policy = await voice.parse_policy(graph, transcript)
    notes = await _settle_policy(policy)
    with runtime.lock:
        body = _state()
    return {"transcript": transcript, "policy": policy, "notes": notes, **body}
