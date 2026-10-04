"""
Energy saver. Which buildings can take a lower power limit, and when, given how
many people are in them?

People come from the class schedule (occupancy.py) for U-M buildings that have
it. Every other building, and every researched campus, uses an hourly shape for
its type, labelled "estimated from building type". Hospitals, feeds and city
buildings are never capped.

The plan functions are pure. `advance` and `live` read and write `graph.saver`.
"""

from __future__ import annotations

import copy
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

SLOTS = 48
SLOT_MINUTES = 30
TICK_MINUTES = 4
DEFAULT_START = 14 * 60
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
LOCATIONS = Path(__file__).resolve().parent / "data" / "locations"

# Share of full demand a building draws when empty (ventilation, servers, fridges).
BASE = {"academic": 0.35, "library": 0.40, "dining": 0.45, "dorm": 0.55, "research": 0.80}
FLOOR = 0.25
NEVER = ("hospital", "feed", "city")

POLICIES: dict[str, dict[str, Any]] = {
    "comfort": {
        "label": "Comfort", "headroom": 0.20, "precondition": 60,
        "types": ("academic", "library"),
        "description": "20% headroom, pre-cool or pre-heat 60 min ahead. Classrooms and libraries only.",
    },
    "balanced": {
        "label": "Balanced", "headroom": 0.10, "precondition": 30,
        "types": ("academic", "library", "dining", "research"),
        "description": "10% headroom, 30 min ahead. Adds dining halls and labs.",
    },
    "aggressive": {
        "label": "Aggressive", "headroom": 0.0, "precondition": 30,
        "types": ("academic", "library", "dining", "research", "dorm"),
        "description": "No headroom, 30 min ahead. Adds residence halls.",
    },
}

# U-M nodes and the registrar codes whose class counts stand for them.
UM_CODES: dict[str, tuple[tuple[str, ...], str]] = {
    "angell": (("AH",), "class schedule"),
    "ross": (("BUS", "R-BUS"), "class schedule"),
    "shapiro": (("UGLI",), "class schedule"),
    "union": (("UNION",), "class schedule and events"),
    "duderstadt": (("DC",), "class schedule"),
    "gg_brown": (("GGBL",), "class schedule"),
    "ncrc": (("NCRC",), "class schedule"),
    "pierpont": (("PIER",), "class schedule and events"),
    "beyster": (("EECS", "DOW", "FXB"), "North engineering proxy (EECS, DOW, FXB)"),
}

# Researched campuses name a role per building.
ROLE_TYPE = {
    "academic": "academic", "library": "library", "dining": "dining", "housing": "dorm",
    "dorm": "dorm", "research": "research", "hospital": "hospital", "power": "feed",
    "civic": "city", "transit": "city",
}
# Demo kW for a researched building, which has no demand of its own.
TYPE_KW = {"academic": 80, "library": 50, "dining": 40, "dorm": 100, "research": 90, "hospital": 200, "city": 20}
TYPE_PEOPLE = {"academic": 400, "library": 300, "dining": 250, "dorm": 900, "research": 200, "hospital": 500, "city": 60}


def _hours(values: list[float]) -> list[float]:
    """24 hourly values to 48 half-hour slots."""
    return [values[slot // 2] for slot in range(SLOTS)]


# Assumed hourly shapes, 0..1 of the building's own peak.
_ACADEMIC = [0, 0, 0, 0, 0, 0, 0.02, 0.15, 0.6, 0.9, 1, 1, 0.85, 0.95, 1, 0.9, 0.75, 0.55, 0.35, 0.25, 0.2, 0.1, 0.03, 0]
_LIBRARY = [0.25, 0.15, 0.05, 0.03, 0.03, 0.03, 0.05, 0.1, 0.2, 0.35, 0.4, 0.5, 0.6, 0.6, 0.65, 0.7, 0.7, 0.75, 0.85, 1, 1, 0.95, 0.8, 0.5]
_DINING = [0, 0, 0, 0, 0, 0, 0.05, 0.5, 0.6, 0.3, 0.25, 0.8, 1, 0.7, 0.25, 0.2, 0.3, 0.8, 1, 0.6, 0.3, 0.15, 0.05, 0]
_RESEARCH = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.35, 0.5, 0.85, 1, 1, 1, 0.9, 1, 1, 1, 0.95, 0.8, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35]


def template(kind: str, weekday: int, class_share: list[float] | None = None) -> list[float]:
    """Busyness by slot for a building with no headcount of its own."""
    weekend = weekday >= 5
    if kind == "academic":
        shape = _hours(_ACADEMIC)
        return [v * (0.15 if weekend else 1.0) for v in shape]
    if kind == "library":
        return [v * (0.6 if weekend else 1.0) for v in _hours(_LIBRARY)]
    if kind == "dining":
        return [v * (0.75 if weekend else 1.0) for v in _hours(_DINING)]
    if kind == "research":
        return [v * (0.6 if weekend else 1.0) for v in _hours(_RESEARCH)]
    if kind == "dorm":
        # Dorms run inverse to classes: full overnight, emptiest at midday.
        share = class_share or template("academic", weekday)
        return [round(0.95 - 0.6 * s, 4) for s in share]
    return [1.0] * SLOTS


def need_share(kind: str, busyness: float) -> float:
    """Fraction of full demand needed: max(0.25, base + (1 - base) * busyness)."""
    base = BASE.get(kind, 1.0)
    return max(FLOOR, base + (1 - base) * max(0.0, min(1.0, busyness)))


def ceil5(value: float) -> float:
    """Round a fraction up to the next 5%, capped at 100%."""
    return min(1.0, math.ceil(round(value * 20, 6)) / 20)


def limits_for(kind: str, demand: float, need_kw: list[float], policy: str) -> list[float]:
    """Cap per slot. Holds the most needed over the pre-conditioning window, plus headroom."""
    rule = POLICIES[policy]
    if kind not in rule["types"] or demand <= 0:
        return [1.0] * SLOTS
    ahead = math.ceil(rule["precondition"] / SLOT_MINUTES)
    out = []
    for slot in range(SLOTS):
        window = max(need_kw[(slot + k) % SLOTS] for k in range(ahead + 1))
        limit = ceil5(window * (1 + rule["headroom"]) / demand)
        assert limit * demand >= need_kw[slot] - 1e-9, "cap below occupied need"
        out.append(limit)
    return out


def slot_of(minute: int) -> int:
    return (int(minute) % 1440) // SLOT_MINUTES


def clock(minute: int) -> str:
    hour, mins = divmod(int(minute) % 1440, 60)
    return f"{hour:02d}:{mins:02d}"


def parse_weekday(value: str | int | None) -> int:
    if value is None or value == "":
        return 1
    if isinstance(value, int):
        return value % 7
    key = str(value).strip()[:3].title()
    if key not in WEEKDAYS:
        raise ValueError("weekday must be Mon..Sun")
    return WEEKDAYS.index(key)


# ---------- inputs: which buildings, and how busy ----------

def _node_kind(node_type: str) -> str:
    if node_type in BASE:
        return node_type
    if node_type == "hospital":
        return "hospital"
    if node_type == "substation":
        return "feed"
    return "city"


@lru_cache(maxsize=8)
def class_load(weekday: int) -> tuple[dict[str, tuple[int, ...]], tuple[float, ...]] | None:
    """Headcount by registrar code over 48 slots, and the campus class share. None if unavailable."""
    try:
        import events
        import occupancy

        schedule = occupancy._read_cache() or occupancy._read_snapshot()
        if schedule is None:
            return None
        found, _ = events.load_demo_events()
        body = occupancy.project(schedule["meetings"], schedule["places"], weekday, 0.75, occupancy.detroit_now(), False, found)
    except Exception:  # noqa: BLE001 - any failure falls back to type shapes
        return None
    minutes = [row["minutes"] for row in body["slots"]]
    by_code: dict[str, tuple[int, ...]] = {}
    for row in body["buildings"]:
        series = [0] * SLOTS
        for minute, count in zip(minutes, row["students"]):
            series[slot_of(minute)] = max(series[slot_of(minute)], count)
        by_code[row["code"]] = tuple(series)
    totals = [0] * SLOTS
    for minute, row in zip(minutes, body["slots"]):
        totals[slot_of(minute)] = max(totals[slot_of(minute)], row["students"])
    peak = max(totals) or 1
    return by_code, tuple(t / peak for t in totals)


def umich_buildings(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"id": n["id"], "name": n["name"], "kind": _node_kind(n["type"]), "demand": float(n["demand"]),
         "occupancy": int(n.get("baseline_occupancy") or n.get("occupancy") or 0)}
        for n in nodes
    ]


def researched_buildings(campus: str) -> tuple[str, list[dict[str, Any]]] | None:
    path = LOCATIONS / f"{campus}.json"
    if not path.exists() or path.parent != LOCATIONS:
        return None
    raw = json.loads(path.read_text())
    out = []
    for i, b in enumerate(raw.get("buildings") or []):
        kind = ROLE_TYPE.get(str(b.get("role") or "").lower(), "academic")
        out.append({
            "id": b.get("id") or f"b{i}", "name": b.get("name") or f"Building {i + 1}", "kind": kind,
            "demand": float(TYPE_KW.get(kind, 0)), "occupancy": TYPE_PEOPLE.get(kind, 0),
        })
    return raw.get("name") or campus, out


def busyness_for(b: dict[str, Any], weekday: int, load: Any, umich: bool) -> tuple[list[float], str, bool]:
    """Busyness by slot, where it came from, and whether it is measured."""
    kind = b["kind"]
    share = list(load[1]) if load else None
    shape = template(kind, weekday, share)
    if kind in NEVER:
        return [1.0] * SLOTS, "never capped", False
    codes = UM_CODES.get(b["id"]) if umich else None
    if load and codes and kind != "dorm":
        series = [sum(load[0].get(code, (0,) * SLOTS)[s] for code in codes[0]) for s in range(SLOTS)]
        peak = max(series)
        if peak > 0:
            measured = [v / peak for v in series]
            if kind == "academic":
                return measured, codes[1], True
            # Libraries, dining and labs stay busy outside class hours.
            return [max(a, m) for a, m in zip(shape, measured)], f"{codes[1]} and type shape", True
    if kind == "dorm" and load:
        return shape, "inverse to campus classes", True
    return shape, "estimated from building type", False


# ---------- the plan ----------

def plan(buildings: list[dict[str, Any]], weekday: int, policy: str, *, umich: bool = True, campus_name: str = "University of Michigan") -> dict[str, Any]:
    if policy not in POLICIES:
        raise ValueError(f"policy must be one of {', '.join(POLICIES)}")
    load = class_load(weekday) if umich else None
    rule = POLICIES[policy]
    hours = SLOT_MINUTES / 60
    rows = []
    for b in buildings:
        kind, demand = b["kind"], b["demand"]
        busy, source, measured = busyness_for(b, weekday, load, umich)
        never = kind in NEVER
        need_kw = [demand if never else demand * need_share(kind, v) for v in busy]
        limit = [1.0] * SLOTS if never else limits_for(kind, demand, need_kw, policy)
        for s in range(SLOTS):
            assert limit[s] * demand >= need_kw[s] - 1e-9
        # The timeclock runs teaching buildings 06:00-23:00 and sets back overnight.
        timed = kind in ("academic", "library", "dining", "research")
        clock_kw = [demand if (not timed or 12 <= s < 46) else demand * max(FLOOR, BASE[kind]) for s in range(SLOTS)]
        rows.append({
            "id": b["id"], "name": b["name"], "type": kind, "demand": demand,
            "never": never, "managed": kind in rule["types"], "source": source, "measured": measured,
            "busyness": [round(v, 3) for v in busy],
            "people": [round(b["occupancy"] * v) if not never else b["occupancy"] for v in busy],
            "need": [round(kw / demand, 3) if demand else 0 for kw in need_kw],
            "limit": limit,
            "_clock_kw": clock_kw,
        })

    always = [sum(r["demand"] for r in rows)] * SLOTS
    saver = [sum(r["demand"] * r["limit"][s] for r in rows) for s in range(SLOTS)]
    timeclock = [sum(r["_clock_kw"][s] for r in rows) for s in range(SLOTS)]
    for r in rows:
        r["kw_saved"] = [round(r["demand"] * (1 - r["limit"][s]), 1) for s in range(SLOTS)]
        r["kwh_saved"] = round(sum(r["kw_saved"]) * hours, 1)
        del r["_clock_kw"]
    capped = [[r for r in rows if r["limit"][s] < 1] for s in range(SLOTS)]
    people_now = [sum(r["people"][s] for r in capped[s]) for s in range(SLOTS)]
    totals = {
        "kwh_always_on": round(sum(always) * hours, 1),
        "kwh_timeclock": round(sum(timeclock) * hours, 1),
        "kwh_saver": round(sum(saver) * hours, 1),
        "kwh_saved": round(sum(a - b for a, b in zip(always, saver)) * hours, 1),
        "kwh_saved_vs_timeclock": round(sum(t - b for t, b in zip(timeclock, saver)) * hours, 1),
        "peak_kw_always_on": round(max(always), 1),
        "peak_kw_saver": round(max(saver), 1),
        "peak_kw_cut": round(max(always) - max(saver), 1),
        "buildings_capped": sum(1 for r in rows if min(r["limit"]) < 1),
        "people_capped_peak": max(people_now),
        "person_hours_capped": round(sum(people_now) * hours),
    }
    totals["pct_saved"] = round(100 * totals["kwh_saved"] / totals["kwh_always_on"], 1) if totals["kwh_always_on"] else 0
    return {
        "campus_name": campus_name,
        "weekday": WEEKDAYS[weekday],
        "policy": policy,
        "policy_label": rule["label"],
        "policies": {k: {"label": v["label"], "description": v["description"], "headroom": v["headroom"], "precondition": v["precondition"], "types": list(v["types"])} for k, v in POLICIES.items()},
        "slots": [{"slot": s, "minute": s * SLOT_MINUTES, "label": clock(s * SLOT_MINUTES)} for s in range(SLOTS)],
        "buildings": rows,
        "series": {"always_on_kw": [round(v, 1) for v in always], "saver_kw": [round(v, 1) for v in saver], "timeclock_kw": [round(v, 1) for v in timeclock]},
        "totals": totals,
        "insight": insight(rows, totals),
        "measured": bool(load),
        "assumptions": assumptions(policy, bool(load), umich),
    }


def insight(rows: list[dict[str, Any]], totals: dict[str, Any]) -> str:
    """One line on where the savings come from, from the numbers."""
    by_kind: dict[str, float] = {}
    periods = {"overnight (22:00-06:00)": 0.0, "in the day (06:00-18:00)": 0.0, "in the evening (18:00-22:00)": 0.0}
    for r in rows:
        by_kind[r["type"]] = by_kind.get(r["type"], 0) + sum(r["kw_saved"])
        for s, kw in enumerate(r["kw_saved"]):
            key = "in the day (06:00-18:00)" if 12 <= s < 36 else "in the evening (18:00-22:00)" if 36 <= s < 44 else "overnight (22:00-06:00)"
            periods[key] += kw
    total = sum(by_kind.values())
    if total <= 0:
        return "No building has room under this policy: every capped type is busy all day."
    kind = max(by_kind, key=by_kind.get)
    when = max(periods, key=periods.get)
    names = {"academic": "academic buildings", "library": "libraries", "dining": "dining halls", "research": "labs", "dorm": "dorms"}
    line = f"Most savings come from {names.get(kind, kind)} {when}, {round(100 * by_kind[kind] / total)}% of the total."
    if totals["kwh_saved"] > 0:
        beyond = max(0.0, totals["kwh_saved_vs_timeclock"]) / totals["kwh_saved"]
        line += f" A plain 06:00-23:00 timeclock would get {round(100 * (1 - beyond))}% of it; the rest is rooms that empty between and after classes."
    dorms = [r for r in rows if r["type"] == "dorm"]
    if dorms and not any(r["managed"] for r in dorms):
        line += " Dorms fill up overnight, so this policy leaves them alone."
    elif dorms:
        line += " Dorms peak overnight, so their caps only bite midday."
    return line


def assumptions(policy: str, measured: bool, umich: bool) -> list[str]:
    rule = POLICIES[policy]
    out = [
        "Kilowatts are demo scale, not metered campus megawatts.",
        "Power need = demand x max(25%, base + (1 - base) x busyness). Base when empty: academic 35%, library 40%, dining 45%, dorm 55%, research 80%.",
        f"{rule['label']}: {round(rule['headroom'] * 100)}% headroom, caps set for the most needed over the next {rule['precondition']} min so rooms are pre-conditioned before people arrive.",
        "Caps round up to the next 5%. Every cap is checked to be at or above the occupied need for its slot.",
        "Hospitals, power feeds and city buildings are never capped.",
        "Timeclock baseline: teaching buildings run full 06:00-23:00 and set back to their empty base overnight; dorms run all day.",
    ]
    if umich and measured:
        out.append("Busyness for U-M teaching buildings is that building's class headcount (Fall 2026 schedule, 75% turnout) over its own weekday peak.")
        out.append("Beyster uses a North engineering proxy (EECS, DOW, FXB). Dorms run inverse to campus classes: 0.95 - 0.6 x class share.")
    else:
        out.append("No headcount for this campus: busyness is estimated from building type (hourly shapes for academic, library, dining, dorm, lab).")
    return out


@lru_cache(maxsize=64)
def _researched_plan(campus: str, weekday: int, policy: str) -> str:
    found = researched_buildings(campus)
    if found is None:
        raise KeyError(campus)
    name, buildings = found
    return json.dumps(plan(buildings, weekday, policy, umich=False, campus_name=name))


def plan_for(graph: Any, weekday: int, policy: str, campus: str = "umich") -> dict[str, Any]:
    if campus in ("", "umich", "university-of-michigan-ann-arbor"):
        nodes = [{"id": n.id, "name": n.name, "type": n.type.value, "demand": n.demand,
                  "baseline_occupancy": n.baseline_occupancy} for n in graph.nodes.values()]
        return plan(umich_buildings(nodes), weekday, policy)
    return json.loads(_researched_plan(campus, weekday, policy))


# ---------- live: caps on the running clock ----------

def start(graph: Any, policy: str, weekday: int, start_minute: int) -> dict[str, Any]:
    body = plan_for(graph, weekday, policy)
    graph.saver = {
        "policy": policy,
        "weekday": weekday,
        "start_minute": int(start_minute) % 1440,
        "start_tick": graph.tick_count,
        "limits": {r["id"]: r["limit"] for r in body["buildings"]},
        "need": {r["id"]: r["need"] for r in body["buildings"]},
        "people": {r["id"]: r["people"] for r in body["buildings"]},
        "kwh": 0.0,
        "caps": {},
        "minute": int(start_minute) % 1440,
    }
    return body


def minute_at(saver: dict[str, Any], tick: int) -> int:
    return (saver["start_minute"] + (tick - saver["start_tick"]) * TICK_MINUTES) % 1440


def advance(graph: Any) -> list[str]:
    """Set caps for the coming tick's clock slot. Logs only when caps change."""
    saver = getattr(graph, "saver", None)
    if not saver:
        for node in graph.nodes.values():
            if node.limit != 1.0:
                node.limit = 1.0
        return []
    minute = minute_at(saver, graph.tick_count + 1)
    slot = slot_of(minute)
    caps: dict[str, float] = {}
    for node in graph.nodes.values():
        limits = saver["limits"].get(node.id)
        node.limit = limits[slot] if limits else 1.0
        if node.limit < 1.0:
            caps[node.id] = node.limit
    saved_kw = sum(n.demand * (1 - n.limit) for n in graph.nodes.values() if not n.failed and n.limit < 1)
    if graph.tick_count >= saver["start_tick"]:
        saver["kwh"] += saved_kw * TICK_MINUTES / 60
    saver["minute"] = minute
    if caps == saver["caps"]:
        return []
    saver["caps"] = caps
    if not caps:
        return [f"Energy saver {clock(minute)}: caps lifted, buildings back to full power"]
    parts = [f"{graph.nodes[nid].name} {round(v * 100)}%" for nid, v in sorted(caps.items(), key=lambda kv: kv[1])]
    more = f", +{len(parts) - 4} more" if len(parts) > 4 else ""
    return [f"Energy saver {clock(minute)}: capped {', '.join(parts[:4])}{more} ({saved_kw:.0f} kW saved)"]


def live(graph: Any) -> dict[str, Any] | None:
    saver = getattr(graph, "saver", None)
    if not saver:
        return None
    slot = slot_of(saver["minute"])
    caps = {nid: v for nid, v in saver["caps"].items() if nid in graph.nodes}
    return {
        "policy": saver["policy"],
        "policy_label": POLICIES[saver["policy"]]["label"],
        "weekday": WEEKDAYS[saver["weekday"]],
        "minute": saver["minute"],
        "clock": clock(saver["minute"]),
        "slot": slot,
        "caps": caps,
        "until": {nid: clock(_until(saver["limits"][nid], slot) * SLOT_MINUTES) for nid in caps},
        "kw_saved_now": round(sum(graph.nodes[nid].demand * (1 - v) for nid, v in caps.items() if not graph.nodes[nid].failed), 1),
        "kwh_saved": round(saver["kwh"], 2),
        "people_capped": sum(saver["people"].get(nid, [0] * SLOTS)[slot] for nid in caps),
    }


def _until(limits: list[float], slot: int) -> int:
    """First later slot where the cap changes."""
    for k in range(1, SLOTS):
        if limits[(slot + k) % SLOTS] != limits[slot]:
            return (slot + k) % SLOTS
    return slot


# ---------- compare policies on forked copies ----------

def compare(graph: Any, weekday: int, start_minute: int, strategy: str, end_minute: int = 23 * 60 + 30) -> dict[str, Any]:
    """Run off / comfort / balanced / aggressive to 23:30 and rank by kWh saved."""
    from agents.logic import apply_energy, apply_transit
    from graph import Priority, Status

    live_saver = getattr(graph, "saver", None)
    if live_saver:
        start_minute = live_saver["minute"]
    ticks = max(1, ((end_minute - start_minute) % 1440) // TICK_MINUTES)
    results = []
    for policy in ("off", *POLICIES):
        sim = copy.deepcopy(graph)
        sim.saver = None
        if policy != "off":
            start(sim, policy, weekday, start_minute)
        essential_seen, critical_seen, short = [], [], 0
        for _ in range(ticks):
            advance(sim)
            sim.advance_heat_wave()
            apply_energy(sim, strategy)
            sim.tick()
            apply_transit(sim)
            consumers = [n for n in sim.nodes.values() if not n.is_supplier]
            essential = [n for n in consumers if n.priority in (Priority.CRITICAL, Priority.HIGH)]
            critical = [n for n in consumers if n.priority == Priority.CRITICAL]
            essential_seen.append(_served(essential))
            critical_seen.append(_served(critical))
            if sim.saver:
                slot = slot_of(minute_at(sim.saver, sim.tick_count))
                for n in consumers:
                    need = sim.saver["need"].get(n.id)
                    if need and n.limit < 1 and not n.failed and n.load_shed <= 0 and n.current_power < need[slot] * n.demand - 1e-6:
                        short += 1
        saver = sim.saver
        results.append({
            "id": policy,
            "label": "Saver off" if policy == "off" else POLICIES[policy]["label"],
            "description": "Every building at full power." if policy == "off" else POLICIES[policy]["description"],
            "metrics": {
                "kwh_saved": round(saver["kwh"], 1) if saver else 0.0,
                "essential_served": round(sum(essential_seen) / len(essential_seen), 4),
                "critical_served": round(min(critical_seen), 4),
                "people_dark": sum(n.occupancy for n in sim.nodes.values() if n.status == Status.RED),
                "short_ticks": short,
                "meets_need": short == 0,
            },
        })
    off = results[0]["metrics"]["essential_served"]
    for r in results:
        m = r["metrics"]
        m["eligible"] = m["meets_need"] and m["essential_served"] >= off - 1e-6
    ranked = sorted(results, key=lambda r: (not r["metrics"]["eligible"], -r["metrics"]["kwh_saved"]))
    for i, r in enumerate(ranked):
        r["metrics"]["rank"] = i + 1
    winner = next((r["id"] for r in ranked if r["metrics"]["eligible"] and r["id"] != "off"), "off")
    return {
        "mode": "saver",
        "base_tick": graph.tick_count,
        "ticks": ticks,
        "start": clock(start_minute),
        "end": clock(end_minute),
        "weekday": WEEKDAYS[weekday],
        "winner": winner,
        "branches": ranked,
    }


def _served(nodes: list) -> float:
    wanted = sum(n.allowed_demand for n in nodes)
    if wanted <= 0:
        return 1.0
    return min(1.0, sum(n.current_power for n in nodes) / wanted)


# ---------- HTTP ----------

class ApplyRequest(BaseModel):
    policy: str = "balanced"
    weekday: str = "Tue"
    start_minute: int = Field(DEFAULT_START, ge=0, lt=1440)


def build_router(graph: Any, publisher: Any):
    from fastapi import APIRouter, HTTPException

    from agents import runtime

    router = APIRouter(prefix="/savings", tags=["sustainability"])

    def day(value: str | None) -> int:
        try:
            return parse_weekday(value)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/plan")
    def get_plan(weekday: str = "Tue", policy: str = "balanced", campus: str = "umich") -> dict:
        if policy not in POLICIES:
            raise HTTPException(status_code=400, detail=f"policy must be one of {', '.join(POLICIES)}")
        with runtime.lock:
            try:
                body = plan_for(graph, day(weekday), policy, campus)
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="No researched campus with that id.") from exc
            body["live"] = live(graph)
        body["campus"] = campus
        return body

    @router.get("/campuses")
    def get_campuses() -> dict:
        """U-M first, then every researched campus. Those use building-type estimates."""
        out = [{"id": "umich", "name": "University of Michigan", "measured": True}]
        for path in sorted(LOCATIONS.glob("*.json")):
            if path.stem == "university-of-michigan-ann-arbor":
                continue
            try:
                name = json.loads(path.read_text()).get("name") or path.stem
            except (OSError, json.JSONDecodeError):
                continue
            out.append({"id": path.stem, "name": name, "measured": False})
        return {"campuses": out}

    @router.post("/apply")
    async def post_apply(req: ApplyRequest) -> dict:
        if req.policy not in POLICIES:
            raise HTTPException(status_code=400, detail=f"policy must be one of {', '.join(POLICIES)}")
        weekday = day(req.weekday)
        label = f"Energy saver · {POLICIES[req.policy]['label']}, {WEEKDAYS[weekday]}"
        with runtime.lock:
            runtime.forget_after(graph.tick_count)
            # No new scenario log: the saver rides along with whatever is running.
            body = start(graph, req.policy, weekday, req.start_minute)
            runtime.push([f"Director: {label} from {clock(req.start_minute)}. {body['totals']['kwh_saved']} kWh a day vs always-on."])
            # A toggle, not a scenario: leave Pause alone. One forced tick puts the caps on now.
            runtime.run_cycle(graph, force=True)
            state = {"live": live(graph), "totals": body["totals"]}
        await publisher.publish(graph)
        return state

    @router.post("/clear")
    async def post_clear() -> dict:
        with runtime.lock:
            saver = graph.saver
            if saver:
                runtime.forget_after(graph.tick_count)
                graph.saver = None
                runtime.push([f"Director: energy saver off, {saver['kwh']:.1f} kWh saved"])
                runtime.run_cycle(graph, force=True)
        await publisher.publish(graph)
        return {"live": None}

    return router
