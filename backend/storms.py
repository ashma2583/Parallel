"""
Weather the director draws on the map.

The frontend works out what a storm hits and when. This module keeps the storms
on record and applies each hit to the live campus as it lands: buildings and
feeds fail or derate, power lines are cut, roads close (the transit agent
routes around them), and U-M bus lines lose a stretch or the whole line.

A scenario plan can be run again and again. The first run saves the campus as
it stands; each later run puts it back that way before the weather replays.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agents import runtime
from graph import CampusGraph

ROUTES_PATH = Path(__file__).resolve().parent / "data" / "bus_routes.json"
SUSPENDED = "suspended by the director"
# Storms past this many are forgotten, oldest first. What they did stays applied.
MAX_STORMS = 40
STALE = "stale storm"

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
    kind: Kind
    level: int = Field(0, ge=0, le=9)
    label: str = Field(..., min_length=1, max_length=80, examples=["EF3 tornado"])
    path: list[LngLat] = Field(..., min_length=1, max_length=200)
    radius: float = Field(..., ge=1, le=5000, description="Meters")
    headline: str = Field("", max_length=240)


class HitRequest(BaseModel):
    storm_id: str = Field(..., min_length=1, max_length=80)
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
    for storm in getattr(graph, "storms", []):
        if storm["id"] == storm_id:
            return storm["label"]
    return None


def route_reason(graph: CampusGraph, route: dict[str, Any]) -> str:
    """Why a line is closed, e.g. closed by the EF3 tornado (debris across the road)."""
    if route.get("storm_id") is None:
        return route.get("reason") or SUSPENDED
    label = storm_label(graph, route["storm_id"])
    who = f"the {_lower(label)}" if label else "the storm"
    reason = (route.get("reason") or "").strip()
    return f"closed by {who} ({reason})" if reason and reason != "closed" else f"closed by {who}"


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
    # Storm ids from before the last scenario run. A hit still in flight from
    # that run must not land on the campus the new run just put back.
    stale: set[str] = set()
    # Storm ids started or hit since the last scenario run.
    seen: set[str] = set()

    def ok() -> dict[str, Any]:
        return {"ok": True, "weather": weather_state(graph)}

    def live(storm_id: str) -> None:
        if storm_id in stale:
            raise HTTPException(status_code=409, detail=STALE)
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
            stale.discard(req.id)
            seen.add(req.id)
            kept = [s for s in graph.storms if s["id"] != req.id]
            graph.storms = kept[-(MAX_STORMS - 1):] + [record]
            runtime.push([_line(req.headline.strip() or f"{record['label']} on the map")])
            return ok()

    @router.post("/hit")
    async def post_hit(req: HitRequest) -> dict:
        """Apply what the storm just reached, log it, and let the agents respond."""
        with runtime.lock:
            live(req.storm_id)
            apply_hit(graph, req)
            lines = [_line(text) for text in req.lines if text.strip()]
            if lines:
                runtime.push(lines)
            runtime.run_cycle(graph, force=True)
            body = ok()
        await publisher.publish(graph)
        return body

    @router.post("/end")
    def post_end(req: EndRequest) -> dict:
        with runtime.lock:
            live(req.storm_id)
            storm = next((s for s in graph.storms if s["id"] == req.storm_id), None)
            if storm is None:
                raise HTTPException(status_code=404, detail="No storm with that id.")
            if storm["status"] != "done":
                storm["status"] = "done"
                storm["summary"] = req.summary.strip() or None
                runtime.push([_line(req.summary.strip() or f"{storm['label']} has passed")])
            return ok()

    @router.post("/routes/suspend")
    def post_suspend(req: SuspendRequest) -> dict:
        """Take a whole U-M line out of service."""
        name = req.name.strip() or route_name(req.id)
        with runtime.lock:
            graph.closed_routes = [r for r in graph.closed_routes if not _suspension(r, req.id)]
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
                runtime.push([f"Director: U-M {lifted[0]['name']} back in service"])
            return ok()

    @router.post("/scenario/run")
    async def post_scenario_run() -> dict:
        """Start a run of the plan. The first run saves the campus; later runs put it back, then the weather clears."""
        with runtime.lock:
            baseline = getattr(graph, "scenario_baseline", None)
            restored = baseline is not None
            if restored:
                _restore(graph, baseline)
            else:
                graph.scenario_baseline = _snapshot(graph)
            stale.update(seen, (s["id"] for s in graph.storms))
            seen.clear()
            graph.storms, graph.closed_routes, graph.cut_edges, graph.closed_roads = [], [], [], []
            runtime.push([
                "Director: scenario run, campus restored to its starting state"
                if restored else "Director: scenario run, starting state saved"
            ])
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
    """Everything a run can change: buildings with their failures and people, links, planned buildings."""
    return copy.deepcopy({"nodes": graph.nodes, "edges": graph.edges, "proposals": graph.proposals})


def _restore(graph: CampusGraph, baseline: dict[str, Any]) -> None:
    """Planned buildings added after the snapshot go away; ones placed before it come back."""
    saved = copy.deepcopy(baseline)
    graph.nodes = saved["nodes"]
    graph.edges = saved["edges"]
    graph.proposals = saved["proposals"]


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


def _line(text: str) -> str:
    text = " ".join(text.split())[:240]
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
