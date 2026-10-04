"""
Specialist logic for the PARALLEL Coordinator, as plain functions.

No uAgents imports and no network calls, so these are trivially testable and
safe to import from anywhere. Every number they return comes straight from the
engine's own responses (POST /branch, GET /briefing, GET /state).

  Energy Planner  - ranks the shed-policy branches from POST /branch.
  Transit Planner - bus reroutes and shelters from GET /briefing.
  Repair Crew     - which failed node to restore first, by people helped.
"""

from __future__ import annotations

from typing import Any

ENERGY = "Energy Planner"
TRANSIT = "Transit Planner"
REPAIR = "Repair Crew"


# ---------------------------------------------------------------- Energy Planner
def rank_policies(branch_resp: dict[str, Any], top: int = 3) -> list[dict[str, Any]]:
    """Rank branches by essential_served (high first), then people_dark (low first).

    Ties after that go to fewer people relocated, then the engine's own order, so
    the ranking is deterministic and still uses only simulator numbers.
    """
    rows = []
    for order, b in enumerate(branch_resp.get("branches") or []):
        m = b.get("metrics") or {}
        rows.append(
            {
                "id": b.get("id"),
                "label": b.get("label") or b.get("id"),
                "description": b.get("description") or "",
                "essential_served": float(m.get("essential_served") or 0.0),
                "people_dark": int(m.get("people_dark") or 0),
                "people_relocated": int(m.get("people_relocated") or 0),
                "buildings_dark": int(m.get("buildings_dark") or 0),
                "proposed_by": ENERGY,
                "_order": order,
            }
        )
    rows.sort(
        key=lambda r: (
            -round(r["essential_served"], 4),
            r["people_dark"],
            r["people_relocated"],
            r["_order"],
        )
    )
    out = []
    for i, r in enumerate(rows[:top], start=1):
        r = {k: v for k, v in r.items() if k != "_order"}
        r["rank"] = i
        out.append(r)
    return out


# --------------------------------------------------------------- Transit Planner
def transit_plan(briefing: dict[str, Any]) -> dict[str, Any]:
    """Bus reroutes and shelters, from the engine briefing."""
    buses = briefing.get("buses") or {}
    cooling = briefing.get("cooling") or {}
    reroutes = [r for r in (buses.get("reroute") or []) if r.get("skip")]
    shelters = [p.get("name") for p in (cooling.get("places") or []) if p.get("name")]
    shelters_open = bool(cooling.get("open"))
    lines = [
        {"id": r.get("id"), "name": r.get("name"), "skip": list(r.get("skip") or [])}
        for r in reroutes
    ]
    if lines:
        shown = "; ".join(
            f"{l['name']} skips {', '.join(l['skip'])}" for l in lines[:2]
        )
        more = f" (+{len(lines) - 2} more lines)" if len(lines) > 2 else ""
        text = f"reroute {len(lines)} bus line(s): {shown}{more}."
    else:
        text = "no bus reroutes needed."
    if shelters_open and shelters:
        text += f" Open shelters at {', '.join(shelters)}."
    return {
        "specialist": TRANSIT,
        "reroutes": lines,
        "shelters": shelters if shelters_open else [],
        "shelters_open": shelters_open,
        "text": text,
    }


# ------------------------------------------------------------------- Repair Crew
def repair_plan(state: dict[str, Any]) -> dict[str, Any]:
    """Which failed node to restore first, ranked by people it brings back.

    A failed substation takes its whole feeder with it, so it is credited with
    the baseline occupancy of the non-substation buildings on that feeder. A
    failed building is credited with its own baseline occupancy.
    """
    nodes = state.get("nodes") or []
    failed = [n for n in nodes if n.get("failed")]
    ranked = []
    for n in failed:
        if n.get("type") == "substation":
            people = sum(
                int(m.get("baseline_occupancy") or 0)
                for m in nodes
                if m.get("feeder") == n.get("feeder") and m.get("type") != "substation"
            )
            # A substation with no dependants (e.g. the plant) still counts itself.
            people = people or int(n.get("baseline_occupancy") or 0)
        else:
            people = int(n.get("baseline_occupancy") or 0)
        ranked.append({"id": n.get("id"), "name": n.get("name") or n.get("id"), "people": people})
    ranked.sort(key=lambda r: (-r["people"], str(r["id"])))
    if not ranked:
        return {"specialist": REPAIR, "first": None, "order": [], "text": "nothing is failed, no repairs needed."}
    first = ranked[0]
    text = f"restore {first['name']} first (about {first['people']:,} people depend on it)."
    if len(ranked) > 1:
        text += " Then " + ", then ".join(r["name"] for r in ranked[1:3]) + "."
    return {"specialist": REPAIR, "first": first, "order": ranked, "text": text}
