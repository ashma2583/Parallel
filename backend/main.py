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
    UM_CLIENT_ID    Schedule of Classes API client id
    UM_CLIENT_SECRET
    UM_TERM         optional term code, default from today's date
    SOC_CSV         optional registrar CSV path or URL
    PEOPLE_DRIVES_SIM  "0" keeps each building's fixed headcount; by default the class
                       schedule sets who is in each U-M building at the campus clock's time
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
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
import occupancy
from agents.logic import STRATEGIES
import location_agent
import proposal
from agents.serve import start_in_thread
from branch import ScenarioBatch, run_branches, scenario_ticks
from graph import CLOCK_START_MINUTES, CampusGraph

# Idle, the clock holds at 14:00; a scenario, heat wave or energy saver starts it. OPEN_PAUSED=0 lets it run.
OPEN_PAUSED = os.getenv("OPEN_PAUSED", "1") != "0"
from stdb import SpacetimePublisher
import savings
from stdb_actions import ActionConsumer, asgi_dispatcher
import storms
import hazards
import voice
import weather

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("parallel")

TICK_SECONDS = float(os.getenv("TICK_SECONDS", "1.0"))

graph = CampusGraph()
publisher = SpacetimePublisher()

# Multiplayer actions (browsers -> SpacetimeDB `action` table -> this engine) run
# only when STDB_ENABLED is explicitly on. Unset or "0" leaves the app as it was.
STDB_ACTIONS = os.getenv("STDB_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}
consumer: ActionConsumer | None = None


def actions_live() -> bool:
    """True while this engine holds the SpacetimeDB lock and is polling for actions.
    The browser sends through the reducer only when this is true."""
    return (
        consumer is not None
        and consumer.has_lock
        and consumer.last_poll_ok is not None
        and time.time() - consumer.last_poll_ok < 5.0
    )


def _play_saver() -> None:
    """While the energy saver plays its day, run extra ticks so the day goes by fast. Caller holds the lock."""
    saver = graph.saver
    until = saver.get("play_until") if saver else None
    if until is None:
        return
    for _ in range(savings.PLAY_SPEED - 1):
        if graph.tick_count >= until:
            break
        runtime.run_cycle(graph, force=True)
    if graph.tick_count >= until:
        saver["play_until"] = None
        runtime.paused = True
        runtime.push([f"Director: energy saver played the day to {savings.clock(savings.PLAY_END)}: {round(saver.get('kwh', 0.0), 1)} kWh saved. Paused; press Play to go on."])


async def _sim_loop() -> None:
    """Publish every cycle. Drive the cycle too if the agent bureau is behind."""
    log.info(
        "sim loop started: every %.2fs, SpacetimeDB %s, xAI %s, policy %s",
        TICK_SECONDS,
        "on" if publisher.enabled else "off",
        "on" if voice.xai_configured() else "off",
        voice.policy_parser(),
    )
    first = True
    while True:
        started = asyncio.get_running_loop().time()
        with runtime.lock:
            if not runtime.paused:
                runtime.run_cycle(graph, force=False)
                _play_saver()
            if first:
                # The campus opens at 14:00 and holds there until something runs.
                runtime.paused = OPEN_PAUSED
                first = False
        await publisher.publish(graph)
        elapsed = asyncio.get_running_loop().time() - started
        await asyncio.sleep(max(0.05, TICK_SECONDS - elapsed))


@asynccontextmanager
async def lifespan(app_: FastAPI):
    global consumer
    runtime.bind(graph, asyncio.get_running_loop(), TICK_SECONDS)
    runtime.remember(graph)
    await publisher.start()
    start_in_thread()
    task = asyncio.create_task(_sim_loop(), name="sim-loop")
    if STDB_ACTIONS and publisher.enabled:
        # Claims the engine lock on its first poll, then applies queued actions.
        consumer = ActionConsumer(publisher.identity_client(), asgi_dispatcher(app_))
        consumer.start()
        log.info("SpacetimeDB action consumer started")
    try:
        yield
    finally:
        if consumer is not None:
            await consumer.stop()
            consumer = None
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
app.include_router(storms.build_router(graph, publisher))
app.include_router(savings.build_router(graph, publisher))


class DisruptRequest(BaseModel):
    node_ids: list[str] = Field(..., min_length=1, examples=[["sub_south"]])
    action: Literal["fail", "restore", "derate"] = Field("fail")
    factor: float = Field(0.5, ge=0.0, le=1.0, description="Output fraction for action=derate")
    reason: str | None = Field(None, examples=["Ice storm knocked out the south substation"])
    reset_count: int | None = Field(None, validation_alias=storms.EPOCH, description="409 when the campus was reset since")


class BranchRequest(BaseModel):
    ticks: int = Field(6, ge=1, le=60)
    strategies: list[str] | None = Field(None, examples=[["tiered", "residential"]])
    # A planned scenario to play forward on each copy, in timed batches.
    scenario: list[ScenarioBatch] | None = Field(None, max_length=400)
    # "saver" compares energy saver policies through 23:30 instead of response policies.
    mode: Literal["policy", "saver"] = "policy"
    weekday: Literal["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] = "Tue"
    start_minute: int = Field(savings.DEFAULT_START, ge=0, lt=1440)


class StrategyRequest(BaseModel):
    strategy: str = Field(..., examples=["residential"])


class PriorityRequest(BaseModel):
    mode: Literal["balanced", "dorms", "academic"]


class SeasonRequest(BaseModel):
    season: Literal["summer", "fall", "winter", "spring"]


class ClockRequest(BaseModel):
    paused: bool | None = None
    until: int | None = Field(None, ge=1, le=100_000)
    # Set the time of day on the campus clock, "HH:MM", at the current tick.
    at: str | None = Field(None, pattern=r"^\d{1,2}:\d{2}$", examples=["20:00"])


class PeopleSelection(BaseModel):
    """What the People tab shows, so the engine counts the same day and turnup."""

    weekday: str | None = Field(None, examples=["Tue"])
    turnup: float | None = Field(None, ge=0, le=1)


# The first briefing build named these modes. Each is one of the strategies.
PRIORITY_STRATEGY = {"balanced": "tiered", "dorms": "residential", "academic": "academic"}


class HazardApplyRequest(BaseModel):
    id: str = Field(..., min_length=1, examples=["ice_storm"])
    reset_count: int | None = Field(None, validation_alias=storms.EPOCH, description="409 when the campus was reset since")


class WeatherApplyRequest(BaseModel):
    id: str = Field(..., min_length=1, examples=["ice-storm-2023"])
class VerdictPolicy(BaseModel):
    id: str
    label: str
    people_dark: int = 0
    people_in_shelter: int = 0
    people_relocated: int = 0
    shelter_kw: float = 0


class VerdictRequest(BaseModel):
    season: str = "fall"
    shelter: Literal["cooling", "warming"] | None = None
    winner: str
    policies: list[VerdictPolicy]


class CommandRequest(BaseModel):
    text: str = Field(..., min_length=1, examples=["The south substation just failed"])


class LocationRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=200)
    refresh: bool = Field(False, description="Research again even if this place is already saved")


class ProposalRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=60)
    kind: Literal["dorm", "academic", "research", "dining", "library"]
    lng: float
    lat: float
    demand_kw: float = Field(..., gt=0, le=400)
    people: int = Field(..., ge=1, le=5000)


def _state() -> dict:
    body = graph.to_dict()
    body["activity"] = list(runtime.activity)
    body["activity_ticks"] = list(runtime.activity_ticks)
    body["scenarios"] = runtime.scenario_logs()
    body["strategy"] = runtime.strategy
    body["reset_count"] = graph.reset_count
    body["saver"] = savings.live(graph)
    body["paused"] = runtime.paused
    body["minutes"] = graph.sim_minutes()
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
                box["notes"] = runtime.apply_order(graph, policy)
                box["done"] = True
    if policy.get("action") == "reset":
        await publisher.clear()
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


@app.post("/actions/poke")
async def poke_actions() -> dict:
    """Browsers call this right after a reducer action lands, so it is applied now
    instead of at the next poll. Harmless when the consumer is off."""
    if consumer is not None:
        consumer.poke()
    return {"ok": consumer is not None}


@app.get("/activity")
def get_activity() -> dict:
    return {**runtime.snapshot(), "saver": savings.live(graph), "actions_live": actions_live(), "paused": runtime.paused, "minutes": graph.sim_minutes()}


@app.get("/bus-routes")
def get_bus_routes() -> dict:
    return briefing.route_collection()


@app.get("/occupancy")
async def get_occupancy(weekday: str | None = None, turnup: float = 0.75) -> dict:
    """Students in class, by building, across the class day.

    turnup is the share of class capacity assumed to be in the room.
    """
    try:
        return await occupancy.snapshot(weekday=weekday, turnup=turnup)
    except occupancy.ScheduleError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/people/now")
def get_people_now() -> dict:
    """Students in class right now, by simulation building, at the campus clock's time of day."""
    with runtime.lock:
        return occupancy.people_now(graph)


@app.post("/people/selection")
async def post_people_selection(req: PeopleSelection) -> dict:
    """The People tab's weekday and turnup. The engine uses them for who is in each building."""
    with runtime.lock:
        try:
            chosen = occupancy.select(req.weekday, req.turnup)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        occupancy.apply_to_graph(graph)
        body = {**chosen, **occupancy.people_now(graph)}
    await publisher.publish(graph)
    return body


@app.get("/briefing")
def get_briefing() -> dict:
    with runtime.lock:
        return briefing.build_briefing(graph, runtime.strategy, runtime.season)


@app.get("/proposals")
def get_proposals() -> dict:
    with runtime.lock:
        return {"proposals": proposal.list_proposals(graph)}


@app.post("/proposal")
async def post_proposal(req: ProposalRequest) -> dict:
    """Drop a planned building onto the live U-M grid and report the effect."""
    with runtime.lock:
        try:
            placed = proposal.place_proposal(
                graph,
                name=req.name,
                kind=req.kind,
                lng=req.lng,
                lat=req.lat,
                demand=req.demand_kw,
                people=req.people,
            )
        except proposal.ProposalError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        runtime.forget_after(graph.tick_count)
        feed = placed["feeder_label"]
        runtime.push([f"Planner: added {req.name.strip()} on the {feed if feed.endswith(' feed') else feed + ' feed'}"])
        runtime.run_cycle(graph, force=True)
        body = proposal.describe(graph, placed)
    await publisher.publish(graph)
    return body


@app.delete("/proposal/{node_id}")
async def delete_proposal(node_id: str) -> dict:
    with runtime.lock:
        if node_id not in graph.proposals:
            raise HTTPException(status_code=404, detail="No planned building with that id.")
        runtime.forget_after(graph.tick_count)
        name = graph.nodes[node_id].name
        graph.remove_proposal(node_id)
        runtime.push([f"Planner: removed {name}"])
        runtime.run_cycle(graph, force=True)
    await publisher.publish(graph)
    return {"removed": node_id}


@app.post("/location")
async def post_location(req: LocationRequest) -> dict:
    """Research a place and return at most 20 buildings and the core transit lines."""
    try:
        found = await location_agent.research_location(req.query, refresh=req.refresh)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not found["buildings"]:
        raise HTTPException(status_code=422, detail="No buildings with a known location came back.")
    return found


@app.post("/debrief")
async def post_debrief() -> dict:
    """Ask Grok for an after-action read of the scenario the director just ran."""
    with runtime.lock:
        report = briefing.build_briefing(graph, runtime.strategy, runtime.season)
        if not report["disrupted"]:
            raise HTTPException(status_code=400, detail="Run a scenario before asking for a summary.")
        facts = briefing.debrief_facts(graph, runtime.strategy, runtime.snapshot()["lines"], runtime.season)
    try:
        return await voice.write_debrief(facts)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/plans")
async def post_plans() -> dict:
    """Five ranked response plans for the outage that is already on the grid."""
    with runtime.lock:
        report = briefing.build_briefing(graph, runtime.strategy, runtime.season)
        if not report["disrupted"]:
            raise HTTPException(status_code=400, detail="Run a scenario before asking for plans.")
        facts = briefing.debrief_facts(graph, runtime.strategy, runtime.snapshot()["lines"], runtime.season)
    try:
        return await voice.write_plans(facts)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/season")
async def post_season(req: SeasonRequest) -> dict:
    with runtime.lock:
        runtime.season = req.season
        return briefing.build_briefing(graph, runtime.strategy, runtime.season)


@app.post("/priority")
async def post_priority(req: PriorityRequest) -> dict:
    """Older name for /strategy. Returns the briefing for the new policy."""
    await post_strategy(StrategyRequest(strategy=PRIORITY_STRATEGY[req.mode]))
    with runtime.lock:
        return briefing.build_briefing(graph, runtime.strategy, runtime.season)


@app.get("/clock")
def get_clock() -> dict:
    with runtime.lock:
        return _clock_body()


def _clock_body() -> dict:
    """Tick, pause, and the campus clock's time of day. Caller holds the lock."""
    minutes = graph.sim_minutes()
    now = occupancy.people_now(graph)
    return {
        "tick": graph.tick_count,
        "paused": runtime.paused,
        "minutes": minutes,
        "time": f"{minutes // 60:02d}:{minutes % 60:02d}",
        "slot": now["slot"],
        "weekday": now["weekday"],
    }


@app.post("/clock")
async def post_clock(req: ClockRequest) -> dict:
    """Pause the clock, or jump it to a saved tick. A jump pauses there."""
    with runtime.lock:
        if req.paused is not None:
            runtime.paused = req.paused
        if req.until is not None:
            if req.until < 1:
                raise HTTPException(status_code=400, detail="Tick starts at 1.")
            if not runtime.recall(graph, req.until):
                if req.until < graph.tick_count:
                    raise HTTPException(status_code=400, detail="That tick is no longer saved.")
                steps = 0
                while graph.tick_count < req.until and steps < 240:
                    runtime.run_cycle(graph, force=True)
                    steps += 1
            runtime.paused = True
        if req.at is not None:
            hour, minute = (int(part) for part in req.at.split(":"))
            if hour > 23 or minute > 59:
                raise HTTPException(status_code=400, detail="at must be a time of day such as 20:00.")
            graph.set_clock(hour * 60 + minute)
            runtime.forget_after(graph.tick_count)
            occupancy.apply_to_graph(graph)
        body = _clock_body()
    await publisher.publish(graph)
    return body


@app.get("/hazards")
async def get_hazards() -> dict:
    """Natural hazards for this campus, most likely first, with live weather alongside."""
    live = await weather.current()
    active = sorted({hid for a in live["alerts"] if (hid := hazards.for_alert(a["event"]))})
    return {**hazards.list_hazards(), "weather": {**live, "active_hazards": active}}


@app.post("/hazards/apply")
async def post_hazard_apply(req: HazardApplyRequest) -> dict:
    """Run a hazard: apply the effect this model assumes it has on the campus feeds."""
    picked = hazards.hazard(req.id)
    if picked is None:
        raise HTTPException(status_code=404, detail="No hazard with that id for this campus.")
    effect = picked.get("effect")
    if not effect:
        raise HTTPException(status_code=400, detail=f"{picked['name']} has no assumed effect on the campus feeds.")
    with runtime.lock:
        storms.check_epoch(graph, req.reset_count)
        runtime.forget_after(graph.tick_count)
        runtime.begin_scenario(picked["name"])
        # Extreme heat runs the four-hour ramp: plant output falls over later ticks.
        steps = [] if req.id == "extreme_heat" else effect["steps"]
        if req.id == "extreme_heat":
            graph.start_heat_wave()
            graph.set_clock(CLOCK_START_MINUTES)
        for step in steps:
            for nid in step["node_ids"]:
                if nid not in graph.nodes:
                    continue
                if step["action"] == "fail":
                    graph.fail_node(nid)
                else:
                    # Stacked events compound: a feed already cut back stays at the lower output.
                    graph.derate_node(nid, min(graph.nodes[nid].derate, step["factor"]))
        runtime.push([
            f"Director: {picked['name']} scenario, {picked['how_often']}",
            f"Director: assumed effect, {effect['label'].lower()}. {effect['why']}",
        ])
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.publish(graph)
    return {"hazard": picked, **body}


@app.get("/weather")
async def get_weather() -> dict:
    """Live National Weather Service conditions and alerts, plus real past warnings to replay."""
    live = await weather.current()
    return {**live, "replays": weather.replays()}


@app.post("/weather/apply")
async def post_weather_apply(req: WeatherApplyRequest) -> dict:
    """Run the effect this model assumes for a live alert or a replayed warning."""
    alert = weather.replay(req.id)
    if alert is None:
        alert = next((a for a in (await weather.current())["alerts"] if a["id"] == req.id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="No alert or replay with that id.")
    effect = alert.get("effect")
    if not effect:
        raise HTTPException(status_code=400, detail=f"{alert['event']} has no assumed effect on the campus feeds.")
    with runtime.lock:
        runtime.forget_after(graph.tick_count)
        runtime.begin_scenario(alert["event"])
        for step in effect["steps"]:
            for nid in step["node_ids"]:
                if nid not in graph.nodes:
                    continue
                if step["action"] == "fail":
                    graph.fail_node(nid)
                else:
                    # Stacked events compound: a feed already cut back stays at the lower output.
                    graph.derate_node(nid, min(graph.nodes[nid].derate, step["factor"]))
        runtime.push([
            f"Weather: {alert['event']} from {alert['office']}",
            f"Director: assumed effect, {effect['label'].lower()}. {effect['why']}",
        ])
        runtime.run_cycle(graph, force=True)
        body = _state()
    await publisher.publish(graph)
    return {"alert": alert, **body}


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
        storms.check_epoch(graph, req.reset_count)
        runtime.forget_after(graph.tick_count)
        runtime.begin_scenario(req.reason or f"{req.action} {', '.join(req.node_ids)}")
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


@app.post("/heat-wave")
async def post_heat_wave() -> dict:
    """Start a four-hour heat build. Each later tick lowers output one step."""
    with runtime.lock:
        runtime.paused = False
        runtime.forget_after(graph.tick_count)
        runtime.begin_scenario("Heat wave, 95°F")
        graph.start_heat_wave()
        graph.set_clock(CLOCK_START_MINUTES)
        runtime.push(["Director: heat wave, 95°F. Plant output falls over the next 4 hours."])
        body = _state()
        body["heat_wave"] = graph.heat_wave_view()
    await publisher.publish(graph)
    return body


@app.post("/reset")
async def post_reset() -> dict:
    with runtime.lock:
        runtime.forget()
        kept = graph.saver
        graph.reset()
        # The energy saver is a focus, not part of the scenario: it stays on across a reset.
        if kept:
            savings.start(graph, kept["policy"], kept["weekday"], kept["minute"])
        runtime.remember(graph)
        runtime.fresh_start()
        runtime.clear_scenarios()
        runtime.push(["Director: campus reset"])
        graph.set_clock(CLOCK_START_MINUTES)
        runtime.run_cycle(graph, force=True)
        # Back to 14:00, held until something runs.
        runtime.paused = OPEN_PAUSED
        body = _state()
    await publisher.clear()
    await publisher.publish(graph)
    return body


@app.post("/branch")
def post_branch(req: BranchRequest) -> dict:
    """Fork the live state and run each response policy forward. The live sim is untouched."""
    if req.mode == "saver":
        with runtime.lock:
            return savings.compare(graph, savings.parse_weekday(req.weekday), req.start_minute, runtime.strategy)
    ids = req.strategies or list(STRATEGIES)
    unknown = [sid for sid in ids if sid not in STRATEGIES]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Unknown strategy id(s): {unknown}")
    with runtime.lock:
        wave = graph.heat_wave
        ticks = req.ticks
        # A heat wave still in progress is compared at its peak, not six seconds in.
        if wave and wave["step"] < wave["span"]:
            ticks = max(req.ticks, wave["span"] - wave["step"])
        through_peak = ticks > req.ticks
        heat = False
        if req.scenario:
            # A planned scenario runs past its last hit, or to the peak of a heat wave it starts.
            ticks, through_peak = scenario_ticks(graph, req.scenario, req.ticks)
            heat = any(b.hazard == "extreme_heat" for b in req.scenario)
        cooling = runtime.season == "summer" or graph.heat_wave is not None or heat
        branches = run_branches(graph, ids, ticks, runtime.season, cooling=cooling, scenario=req.scenario)
        body = {
            "base_tick": graph.tick_count,
            "ticks": ticks,
            "active": runtime.strategy,
            "season": runtime.season,
            "shelter": "cooling" if cooling else "warming",
            "through_peak": through_peak,
            "branches": branches,
        }
        if req.scenario:
            body["through"] = "heat peak" if through_peak else "scenario end"
            body["from_baseline"] = getattr(graph, "scenario_baseline", None) is not None
        return body


@app.post("/verdict")
async def post_verdict(req: VerdictRequest) -> dict:
    """One paragraph on the winning policy, using only the counts the branch run produced."""
    with runtime.lock:
        people = briefing.people_facts(graph)
    facts = {
        "season": req.season,
        "shelter": req.shelter,
        "winner": req.winner,
        "policies": [p.model_dump() for p in req.policies],
        "people_now": people,
    }
    return await voice.write_verdict(facts)


@app.post("/strategy")
async def post_strategy(req: StrategyRequest) -> dict:
    """Adopt a response policy on the live simulation."""
    if req.strategy not in STRATEGIES:
        raise HTTPException(status_code=404, detail=f"Unknown strategy id: {req.strategy}")
    with runtime.lock:
        runtime.forget_after(graph.tick_count)
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
    text = req.text.strip()
    hazard_id = voice.hazard_order(text)
    if hazard_id:
        return await _order_hazard(text, hazard_id)
    policy = await voice.parse_policy(graph, text)
    notes = await _settle_policy(policy)
    with runtime.lock:
        body = _state()
    return {"transcript": text, "policy": policy, "notes": notes, **body}


async def _order_hazard(transcript: str, hazard_id: str) -> dict:
    """A typed or spoken hazard ("an ice storm hit North Campus") runs like the strip's hazard pill.

    A storm the map can draw comes back for the console to draw across the zone named and run, so
    it lands hit by hit like one drawn by hand. Other hazards apply campus-wide here.
    """
    storm = voice.DRAWN_STORMS.get(hazard_id)
    if storm:
        picked = hazards.hazard(hazard_id) or {"name": hazard_id.replace("_", " ").capitalize()}
        zone = voice.order_zone(transcript)
        policy = {
            "action": "storm",
            "hazard": hazard_id,
            "storm": storm,
            "zone": zone,
            "node_ids": [],
            "reason": transcript,
            "summary": f"{picked['name']} across {zone} campus",
            "parser": "keyword",
        }
        with runtime.lock:
            body = _state()
        return {"transcript": transcript, "policy": policy, "notes": [], **body}
    body = await post_hazard_apply(HazardApplyRequest(id=hazard_id))
    picked = body.pop("hazard")
    policy = {
        "action": "hazard",
        "hazard": hazard_id,
        "node_ids": [],
        "reason": transcript,
        "summary": f"{picked['name']} scenario",
        "parser": "keyword",
    }
    return {"transcript": transcript, "policy": policy, "notes": [f"Director: {picked['name']} scenario"], **body}


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
    hazard_id = voice.hazard_order(transcript)
    if hazard_id:
        return await _order_hazard(transcript, hazard_id)
    policy = await voice.parse_policy(graph, transcript)
    notes = await _settle_policy(policy)
    with runtime.lock:
        body = _state()
    return {"transcript": transcript, "policy": policy, "notes": notes, **body}
