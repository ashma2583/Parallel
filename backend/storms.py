"""
Weather the director draws on the map.

The frontend works out what a storm hits and when. This module keeps the storms
on record and applies each hit to the live campus as it lands: buildings and
feeds fail or derate, power lines are cut, roads close (the transit agent
routes around them, or people shelter in place), and U-M bus lines lose a
stretch or the whole line. Hits for a storm from before a reset are refused,
and so are hits for a storm the engine never started. A storm can only start
inside a scenario run, so a run that began before a reset cannot start another.

A scenario plan can be run again and again. The first run saves the campus as
it stands, with whatever is still closed and the storms that closed it; each
later run puts it back that way before the weather replays. What the director
set up by hand since then carries over: planned buildings placed or removed,
and bus lines suspended or lifted.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import AliasChoices, BaseModel, Field

from agents import runtime
from graph import CampusGraph, Status

ROUTES_PATH = Path(__file__).resolve().parent / "data" / "bus_routes.json"
SUSPENDED = "suspended by the director"
# Storms past this many are forgotten, oldest first. What they did stays applied.
MAX_STORMS = 40
STALE = "stale storm"
RESET = "The campus was reset after this run began."
# The director's own tools. Their feed lines are orders, not weather.
DIRECTOR_KINDS = ("blackout", "closure")
# Already said by the Director: prefix.
SAID_BY_DIRECTOR = (" (closed by order)", " by the director")
# Everything a scenario run puts back: buildings with their failures and people,
# links, planned buildings, and the weather on record with what it closed.
SNAPSHOT = ("nodes", "edges", "proposals", "storms", "closed_routes", "cut_edges", "closed_roads", "sheltering")
# The director's own changes named in the feed when a run carries them over.
MAX_CHANGES_NAMED = 5

# The campus epoch a write was made in. "epoch" is accepted too.
EPOCH = AliasChoices("reset_count", "epoch")

Kind = Literal["tornado", "thunderstorm", "ice", "flood", "blizzard", "lightning", "blackout", "closure"]
LngLat = tuple[float, float]


class EdgeMark(BaseModel):
    id: str = Field(..., min_length=1, max_length=120, examples=["power:cpp->south_quad"])
    at: LngLat
    storm_id: str | None = None


class ClosedRoute(BaseModel):
    id: str = Field(..., min_length=1, max_length=40, examples=["CN"])
    name: str = Field("", max_length=80)
    segments: list[list[LngLat]] | None = Field(None, description="Closed stretches. Null closes the whole line.")
    reason: str = Field("closed", max_length=160)
    storm_id: str | None = None


class Derate(BaseModel):
    node_id: str
    factor: float = Field(..., ge=0.0, le=1.0)


class StartRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=80)
    reset_count: int | None = Field(None, validation_alias=EPOCH, description="From /state or the scenario run reply. 409 when the campus was reset since.")
    kind: Kind
    level: int = Field(0, ge=0, le=9)
    label: str = Field(..., min_length=1, max_length=80, examples=["EF3 tornado"])
    path: list[LngLat] = Field(..., min_length=1, max_length=200)
    radius: float = Field(..., ge=1, le=5000, description="Meters")
    headline: str = Field("", max_length=240)


class HitRequest(BaseModel):
    storm_id: str = Field(..., min_length=1, max_length=80)
    reset_count: int | None = Field(None, validation_alias=EPOCH)
    fail: list[str] = Field(default_factory=list)
    derate: list[Derate] = Field(default_factory=list)
    cut_edges: list[EdgeMark] = Field(default_factory=list)
    close_roads: list[EdgeMark] = Field(default_factory=list)
    close_routes: list[ClosedRoute] = Field(default_factory=list)
    lines: list[str] = Field(default_factory=list, max_length=24)


class EndRequest(BaseModel):
    storm_id: str = Field(..., min_length=1, max_length=80)
    summary: str = Field("", max_length=240)


class SuspendRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)
    name: str = Field("", max_length=80)


class RestoreRequest(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)


def weather_state(graph: CampusGraph) -> dict[str, Any]:
    """Storms on record and what they closed. Served at /storms and in the briefing."""
    return copy.deepcopy({
        "storms": getattr(graph, "storms", []),
        "closed_routes": getattr(graph, "closed_routes", []),
        "cut_edges": getattr(graph, "cut_edges", []),
        "closed_roads": getattr(graph, "closed_roads", []),
    })


def weather_digest(graph: CampusGraph) -> dict[str, Any]:
    """The same facts in words, with no geometry. Small enough to hand a language model."""
    return {
        "storms": [
            {"label": s["label"], "status": s["status"], "headline": s.get("headline"), "summary": s.get("summary")}
            for s in getattr(graph, "storms", [])
        ],
        "bus_lines_closed": [
            {"line": r["name"], "why": route_reason(graph, r), "whole_line": r.get("segments") is None}
            for r in getattr(graph, "closed_routes", [])
        ],
        "power_lines_cut": [edge_name(graph, m["id"]) for m in getattr(graph, "cut_edges", [])],
        "roads_closed": [edge_name(graph, m["id"]) for m in getattr(graph, "closed_roads", [])],
    }


def has_weather(graph: CampusGraph) -> bool:
    """Something the weather or the director closed is still closed."""
    return bool(getattr(graph, "closed_routes", None) or getattr(graph, "cut_edges", None) or getattr(graph, "closed_roads", None))


def storm_label(graph: CampusGraph, storm_id: str | None) -> str | None:
    storm = _storm(graph, storm_id)
    return storm["label"] if storm else None


def route_reason(graph: CampusGraph, route: dict[str, Any]) -> str:
    """Why a line is closed, e.g. closed by the EF3 tornado (debris across the road), or closed by the director."""
    if route.get("storm_id") is None:
        return route.get("reason") or SUSPENDED
    storm = _storm(graph, route["storm_id"])
    reason = (route.get("reason") or "").strip()
    if storm is not None and storm.get("kind") == "closure":
        return "closed by the director"
    if storm is None and reason.startswith("closed by"):
        return reason
    who = route_cause(graph, route)
    return f"closed by {who} ({reason})" if reason and reason != "closed" else f"closed by {who}"


def route_cause(graph: CampusGraph, route: dict[str, Any]) -> str:
    """Who closed a line: the EF3 tornado, the director's street closure, or the storm once it is off the record."""
    if route.get("storm_id") is None:
        return "the director"
    storm = _storm(graph, route["storm_id"])
    if storm is None:
        return "the storm"
    label = _lower(storm["label"])
    return f"the director's {label}" if storm.get("kind") == "closure" else f"the {label}"


def joined(items: list[str]) -> str:
    """a, b and c."""
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def check_epoch(graph: CampusGraph, reset_count: int | None) -> None:
    """409 for a write made before the last campus reset. A write that names no epoch is let through."""
    if reset_count is not None and reset_count != getattr(graph, "reset_count", 0):
        raise HTTPException(status_code=409, detail=RESET)


def edge_name(graph: CampusGraph, edge_id: str) -> str:
    """power:cpp->south_quad reads as Central Power Plant to South Quad."""
    _, _, ends = edge_id.partition(":")
    src, _, dst = ends.partition("->")
    if not src or not dst:
        return edge_id
    return " to ".join(graph.nodes[nid].name if nid in graph.nodes else nid for nid in (src, dst))


def route_name(route_id: str) -> str:
    return _route_names().get(route_id, route_id)


def apply_hit(graph: CampusGraph, req: HitRequest) -> None:
    """What one hit does to the campus. Ids the graph no longer has are skipped."""
    for nid in req.fail:
        if nid in graph.nodes:
            graph.fail_node(nid)
    for step in req.derate:
        node = graph.nodes.get(step.node_id)
        if node is not None:
            graph.derate_node(step.node_id, min(node.derate, step.factor))
    for mark in req.cut_edges:
        _mark(graph.cut_edges, mark, req.storm_id)
    for mark in req.close_roads:
        _mark(graph.closed_roads, mark, req.storm_id)
    for route in req.close_routes:
        _close_route(graph, route, req.storm_id)


def build_router(graph: CampusGraph, publisher: Any) -> APIRouter:
    router = APIRouter(prefix="/storms", tags=["weather"])
    # Storm ids from before the last scenario run or campus reset. A hit still
    # in flight from then must not land on the campus that was just put back.
    stale: set[str] = set()
    # Storm ids started or hit since then.
    seen: set[str] = set()
    # Resets seen so far, and the reset count when the last scenario run began.
    epoch: dict[str, int | None] = {"resets": getattr(graph, "reset_count", 0), "run": None}

    def ok() -> dict[str, Any]:
        return {"ok": True, "reset_count": getattr(graph, "reset_count", 0), "weather": weather_state(graph)}

    def retire() -> None:
        stale.update(seen, (s["id"] for s in graph.storms))
        seen.clear()

    def catch_up() -> None:
        """A reset (button, voice, or coordinator) since the last call retires every storm seen before it."""
        resets = getattr(graph, "reset_count", 0)
        if resets != epoch["resets"]:
            epoch["resets"] = resets
            retire()

    def live(storm_id: str, *, started: bool = False) -> None:
        """409 for a storm from before the last run or reset. With started, 404 for one never put on record."""
        catch_up()
        if storm_id in stale:
            raise HTTPException(status_code=409, detail=STALE)
        if started and storm_id not in seen and not any(s["id"] == storm_id for s in graph.storms):
            raise HTTPException(status_code=404, detail="No storm with that id.")
        seen.add(storm_id)

    @router.get("")
    def get_storms() -> dict:
        with runtime.lock:
            return weather_state(graph)

    @router.post("/start")
    def post_start(req: StartRequest) -> dict:
        """Put a storm on record. It does nothing to the campus until its hits land."""
        record = {
            "id": req.id,
            "kind": req.kind,
            "level": req.level,
            "label": req.label.strip(),
            "path": [[lng, lat] for lng, lat in req.path],
            "radius": req.radius,
            "status": "active",
            "headline": req.headline.strip() or None,
            "summary": None,
        }
        with runtime.lock:
            catch_up()
            check_epoch(graph, req.reset_count)
            # The campus was reset since the run began, or no run has begun since.
            if epoch["run"] != getattr(graph, "reset_count", 0):
                raise HTTPException(status_code=409, detail=RESET)
            stale.discard(req.id)
            seen.add(req.id)
            kept = [s for s in graph.storms if s["id"] != req.id]
            graph.storms = kept[-(MAX_STORMS - 1):] + [record]
            runtime.push([_line(req.headline.strip() or f"{record['label']} on the map", req.kind)])
            return ok()

    @router.post("/hit")
    async def post_hit(req: HitRequest) -> dict:
        """Apply what the storm just reached, log it, and let the agents respond."""
        with runtime.lock:
            check_epoch(graph, req.reset_count)
            live(req.storm_id, started=True)
            apply_hit(graph, req)
            kind = (_storm(graph, req.storm_id) or {}).get("kind")
            lines = [_line(text, kind) for text in req.lines if text.strip()]
            if lines:
                runtime.push(lines)
            runtime.run_cycle(graph, force=True)
            body = ok()
        await publisher.publish(graph)
        return body

    @router.post("/end")
    def post_end(req: EndRequest) -> dict:
        with runtime.lock:
            live(req.storm_id, started=True)
            storm = next((s for s in graph.storms if s["id"] == req.storm_id), None)
            if storm is None:
                raise HTTPException(status_code=404, detail="No storm with that id.")
            if storm["status"] != "done":
                storm["status"] = "done"
                storm["summary"] = req.summary.strip() or None
                runtime.push([_line(req.summary.strip() or f"{storm['label']} has passed", storm.get("kind"))])
            return ok()

    @router.post("/routes/suspend")
    def post_suspend(req: SuspendRequest) -> dict:
        """Take a whole U-M line out of service. A line already suspended is left as it is."""
        name = req.name.strip() or route_name(req.id)
        with runtime.lock:
            if not any(_suspension(r, req.id) for r in graph.closed_routes):
                graph.closed_routes.append({"id": req.id, "name": name, "segments": None, "reason": SUSPENDED, "storm_id": None})
                runtime.push([f"Director: suspended U-M {name}"])
            return ok()

    @router.post("/routes/restore")
    def post_restore(req: RestoreRequest) -> dict:
        """Lift the director's suspension. Stretches the weather closed stay closed."""
        with runtime.lock:
            lifted = [r for r in graph.closed_routes if _suspension(r, req.id)]
            if lifted:
                graph.closed_routes = [r for r in graph.closed_routes if not _suspension(r, req.id)]
                runtime.push([f"Director: {lifted_line(graph, req.id, lifted[0]['name'])}"])
            return ok()

    @router.post("/scenario/run")
    async def post_scenario_run() -> dict:
        """
        Start a run of the plan. The first run saves the campus as it stands, closures
        and the storms behind them included; later runs put that back, keeping the
        planned buildings and bus suspensions the director has changed since. Either
        way the plan's weather starts from the saved campus, and earlier storms are over.
        """
        with runtime.lock:
            catch_up()
            # A run starts the clock.
            runtime.paused = False
            epoch["run"] = getattr(graph, "reset_count", 0)
            baseline = getattr(graph, "scenario_baseline", None)
            restored = baseline is not None
            kept: list[str] = []
            if restored:
                setup = _setup(graph)
                _restore(graph, baseline)
                kept = _keep_setup(graph, setup)
                if kept:
                    graph.scenario_baseline = _snapshot(graph)
            else:
                for storm in graph.storms:
                    storm["status"] = "done"
                graph.scenario_baseline = _snapshot(graph)
            retire()
            lines = [
                "Director: scenario run, campus restored to its starting state"
                if restored else "Director: scenario run, starting state saved"
            ]
            if kept:
                named = kept[:MAX_CHANGES_NAMED] + ([f"{len(kept) - MAX_CHANGES_NAMED} more"] if len(kept) > MAX_CHANGES_NAMED else [])
                lines.append(f"Director: kept the changes made since the last run: {', '.join(named)}")
            runtime.push(lines)
            runtime.run_cycle(graph, force=True)
            body = {**ok(), "restored": restored}
        await publisher.publish(graph)
        return body

    @router.post("/scenario/clear")
    def post_scenario_clear() -> dict:
        """Forget the saved starting state. The next run saves the campus as it is then."""
        with runtime.lock:
            graph.scenario_baseline = None
        return {"ok": True}

    return router


def _snapshot(graph: CampusGraph) -> dict[str, Any]:
    return copy.deepcopy({key: getattr(graph, key) for key in SNAPSHOT})


def _restore(graph: CampusGraph, baseline: dict[str, Any]) -> None:
    """The campus exactly as saved. _keep_setup then carries over the director's changes since."""
    for key, value in copy.deepcopy(baseline).items():
        setattr(graph, key, value)


def _setup(graph: CampusGraph) -> dict[str, Any]:
    """What the director set up by hand: planned buildings with their links, and bus suspensions."""
    return copy.deepcopy({
        "proposals": {
            nid: (meta, graph.nodes[nid], [e for e in graph.edges if nid in (e.source, e.target)])
            for nid, meta in graph.proposals.items()
            if nid in graph.nodes
        },
        "suspended": [r for r in graph.closed_routes if r.get("storm_id") is None],
    })


def _keep_setup(graph: CampusGraph, setup: dict[str, Any]) -> list[str]:
    """
    Carry the director's setup onto the campus just put back. A building placed
    since comes in lit and full; one removed since stays gone; suspensions are
    the director's current ones. Returns each change in words.
    """
    changes: list[str] = []
    wanted = setup["proposals"]
    for nid in list(graph.proposals):
        node = graph.nodes.get(nid)
        if nid in wanted and _same_building(node, graph.proposals[nid], wanted[nid][1], wanted[nid][0]):
            continue
        graph.remove_proposal(nid)
        graph.sheltering.discard(nid)
        changes.append(f"{node.name if node else nid} removed")
    for nid, (meta, node, edges) in wanted.items():
        if nid in graph.proposals:
            continue
        node.failed = False
        node.derate = 1.0
        node.load_shed = 0.0
        node.occupancy = node.baseline_occupancy
        node.current_power = 0.0
        node.status = Status.GREEN
        graph.nodes[nid] = node
        graph.edges.extend(e for e in edges if e.source in graph.nodes and e.target in graph.nodes)
        graph.proposals[nid] = meta
        changes.append(f"{node.name} placed")
    before = {r["id"]: r for r in graph.closed_routes if r.get("storm_id") is None}
    after = {r["id"]: r for r in setup["suspended"]}
    graph.closed_routes = [r for r in graph.closed_routes if r.get("storm_id") is not None] + setup["suspended"]
    changes += [f"U-M {r['name']} suspended" for rid, r in after.items() if rid not in before]
    changes += [lifted_line(graph, rid, r["name"]) for rid, r in before.items() if rid not in after]
    return changes


def lifted_line(graph: CampusGraph, route_id: str, name: str) -> str:
    """A suspension just lifted, in words: back in service, on a detour, or still out because of the weather."""
    import briefing  # briefing imports this module, so not at the top

    weather = [r for r in graph.closed_routes if r["id"] == route_id]
    if not weather:
        return f"U-M {name} back in service"
    who = joined(list(dict.fromkeys(route_cause(graph, r) for r in weather)))
    if any(r.get("segments") is None for r in weather) or briefing.every_stop_closed(
            route_id, [seg for r in weather for seg in r["segments"] or []]):
        return f"U-M {name} suspension lifted, still closed at every stop by {who}"
    return f"U-M {name} back in service, detouring around the stretches closed by {who}"


def _same_building(saved: Any, saved_meta: dict[str, Any], now: Any, now_meta: dict[str, Any]) -> bool:
    """A planned id can be reused for a different building after a removal."""
    if saved is None:
        return False
    return saved_meta == now_meta and (saved.name, saved.type, saved.demand, saved.baseline_occupancy) == (
        now.name, now.type, now.demand, now.baseline_occupancy)


def _storm(graph: CampusGraph, storm_id: str | None) -> dict[str, Any] | None:
    return next((s for s in getattr(graph, "storms", []) if s["id"] == storm_id), None)


def _mark(marks: list[dict[str, Any]], mark: EdgeMark, storm_id: str) -> None:
    if any(m["id"] == mark.id for m in marks):
        return
    marks.append({"id": mark.id, "at": list(mark.at), "storm_id": mark.storm_id or storm_id})


def _close_route(graph: CampusGraph, route: ClosedRoute, storm_id: str) -> None:
    """One entry per line per storm. A second hit on the same line adds its stretches."""
    owner = route.storm_id or storm_id
    segments = None if route.segments is None else [[list(p) for p in seg] for seg in route.segments if len(seg) >= 2]
    for entry in graph.closed_routes:
        if entry["id"] == route.id and entry.get("storm_id") == owner:
            if entry["segments"] is not None:
                entry["segments"] = None if segments is None else entry["segments"] + segments
            return
    graph.closed_routes.append({
        "id": route.id,
        "name": route.name.strip() or route_name(route.id),
        "segments": segments,
        "reason": route.reason.strip() or "closed",
        "storm_id": owner,
    })


def _suspension(route: dict[str, Any], route_id: str) -> bool:
    return route["id"] == route_id and route.get("storm_id") is None


def _line(text: str, kind: str | None = None) -> str:
    """A feed line for a storm. The director's own tools speak as the director."""
    text = " ".join(text.split())[:240]
    if kind in DIRECTOR_KINDS:
        for said in SAID_BY_DIRECTOR:
            text = text.replace(said, "")
        return text if text.startswith("Director:") else f"Director: {text.removeprefix('Weather: ')}"
    return text if text.startswith("Weather:") else f"Weather: {text}"


def _lower(label: str) -> str:
    """Derecho reads derecho mid-sentence. EF3 tornado keeps its capitals."""
    if len(label) > 1 and label[0].isupper() and label[1].islower():
        return label[0].lower() + label[1:]
    return label


@lru_cache(maxsize=1)
def _route_names() -> dict[str, str]:
    if not ROUTES_PATH.exists():
        return {}
    doc = json.loads(ROUTES_PATH.read_text())
    return {
        str(p.get("id")): str(p.get("name") or p.get("id"))
        for p in doc.get("patterns") or []
        if p.get("agency") == "umich"
    }
