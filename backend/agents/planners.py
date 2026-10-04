"""
Specialist logic for the PARALLEL Coordinator, as plain functions.

No uAgents imports and no network calls, so these are trivially testable and
safe to import from anywhere. Every number they return comes straight from the
engine's own responses (POST /branch, GET /briefing, GET /state).

  Energy Planner  - ranks the shed-policy branches from POST /branch.
  Transit Planner - bus reroutes and shelters from GET /briefing, and where
                    the students in dark buildings should go.
  Repair Crew     - which failed node to restore first, by students and people helped.

The students come from GET /people/now: who is in class in each building at the
campus clock's time of day.
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


# ------------------------------------------------------------------- students
def students_by_node(people: dict[str, Any] | None) -> dict[str, int]:
    """Students in class now, by simulation building, from GET /people/now."""
    out: dict[str, int] = {}
    for row in (people or {}).get("buildings") or []:
        if row.get("node_id"):
            out[row["node_id"]] = out.get(row["node_id"], 0) + int(row.get("students") or 0)
    return out


def _count(n: int, noun: str = "student") -> str:
    return f"{n:,} {noun}{'' if n == 1 else 's'}"


# --------------------------------------------------------------- Transit Planner
def transit_plan(
    briefing: dict[str, Any],
    people: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bus reroutes and shelters, from the engine briefing.

    With the students and the state, it also says where each dark building's
    students should go: the lit building with the most room, meaning the fewest
    people in it now, never a hospital or a feed.
    """
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
    moves = student_moves(state, people)
    if moves:
        shown = "; ".join(
            f"{_count(m['students'])} in {m['from_name']} now go to {m['to_name']} ({m['room']:,} people there now)"
            for m in moves[:2]
        )
        text += f" Students: {shown}."
    return {
        "specialist": TRANSIT,
        "reroutes": lines,
        "shelters": shelters if shelters_open else [],
        "shelters_open": shelters_open,
        "students": moves,
        "text": text,
    }


# Where people can wait out an outage. Never a feed, a hospital, or a civic building.
_SHELTER_TYPES = {"academic", "library", "dining", "dorm", "research"}


def _road_hops(state: dict[str, Any], src: str) -> dict[str, int]:
    """Road hops from one building to every other, over the state's road edges."""
    adj: dict[str, list[str]] = {}
    for e in state.get("edges") or []:
        if e.get("type") == "road":
            adj.setdefault(e["source"], []).append(e["target"])
            adj.setdefault(e["target"], []).append(e["source"])
    hops = {src: 0}
    queue = [src]
    for cur in queue:
        for nxt in adj.get(cur, []):
            if nxt not in hops:
                hops[nxt] = hops[cur] + 1
                queue.append(nxt)
    return hops


def student_moves(state: dict[str, Any] | None, people: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Dark buildings with students in them, busiest first, each with the nearest lit building that has room.

    Room is the fewest people in it now, counting the students already sent there.
    """
    nodes = (state or {}).get("nodes") or []
    students = students_by_node(people)
    if not nodes or not students:
        return []
    lit = [
        n for n in nodes
        if n.get("status") == "Green" and not n.get("failed") and n.get("type") in _SHELTER_TYPES
    ]
    dark = [
        n for n in nodes
        if (n.get("failed") or n.get("status") == "Red")
        and n.get("type") in _SHELTER_TYPES
        and students.get(n["id"], 0) > 0
    ]
    taken: dict[str, int] = {}
    moves = []
    for n in sorted(dark, key=lambda n: (-students[n["id"]], n["id"])):
        if not lit:
            break
        hops = _road_hops(state or {}, n["id"])
        dest = min(
            lit,
            key=lambda d: (
                hops.get(d["id"], 99),
                int(d.get("occupancy") or 0) + taken.get(d["id"], 0),
                d["id"],
            ),
        )
        taken[dest["id"]] = taken.get(dest["id"], 0) + students[n["id"]]
        moves.append({
            "from": n["id"],
            "from_name": n.get("name") or n["id"],
            "students": students[n["id"]],
            "to": dest["id"],
            "to_name": dest.get("name") or dest["id"],
            "room": int(dest.get("occupancy") or 0),
        })
    return moves


# ------------------------------------------------------------------- Repair Crew
def repair_plan(state: dict[str, Any], people: dict[str, Any] | None = None) -> dict[str, Any]:
    """Which failed node to restore first, ranked by the students it brings back, then people.

    A failed substation takes its whole feeder with it, so it is credited with
    the baseline occupancy and the students in class in the non-substation
    buildings on that feeder. A failed building is credited with its own. The
    baseline already follows the class schedule, so both counts are real people.
    """
    nodes = state.get("nodes") or []
    students = students_by_node(people)
    failed = [n for n in nodes if n.get("failed")]
    ranked = []
    for n in failed:
        if n.get("type") == "substation":
            group = [m for m in nodes if m.get("feeder") == n.get("feeder") and m.get("type") != "substation"]
            people_n = sum(int(m.get("baseline_occupancy") or 0) for m in group)
            # A substation with no dependants (e.g. the plant) still counts itself.
            people_n = people_n or int(n.get("baseline_occupancy") or 0)
            in_class = sum(students.get(m["id"], 0) for m in group)
        else:
            people_n = int(n.get("baseline_occupancy") or 0)
            in_class = students.get(n["id"], 0)
        ranked.append({
            "id": n.get("id"),
            "name": n.get("name") or n.get("id"),
            "people": people_n,
            "students": in_class,
            "feed": n.get("type") == "substation",
        })
    ranked.sort(key=lambda r: (-r["students"], -r["people"], str(r["id"])))
    if not ranked:
        return {"specialist": REPAIR, "first": None, "order": [], "text": "nothing is failed, no repairs needed."}
    first = ranked[0]
    text = f"restore {first['name']} first (about {first['people']:,} people depend on it"
    if first["students"]:
        where = "in class on that feed" if first["feed"] else f"in {first['name']}"
        text += f", {_count(first['students'])} {where} now"
    text += ")."
    if len(ranked) > 1:
        text += " Then " + ", then ".join(r["name"] for r in ranked[1:3]) + "."
    return {"specialist": REPAIR, "first": first, "order": ranked, "text": text}
