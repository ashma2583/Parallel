"""
PARALLEL Coordinator: a Fetch.ai uAgent that speaks the Agent Chat Protocol and
drives the campus digital-twin engine over HTTP.

Chat flow (all numbers come from the simulator, ASI:One only parses and phrases):
  scenario text -> ASI:One asi1-mini parses it (8 s cap, keyword fallback)
                -> POST /hazards/apply {id}  or  POST /disrupt {node_ids, fail}
                -> POST /branch {ticks: 8}
                -> top 3 policies ranked by essential_served, then people_dark,
                   each tagged with the specialist that proposed it
  "adopt N"     -> POST /strategy {strategy}  (or POST /disrupt restore for the Repair Crew
                   option) -> live summary from /state and /briefing
  "status", "reset", "help" are handled too.

Specialist logic (Energy Planner, Transit Planner, Repair Crew) is plain
functions in agents/planners.py.

Separate process, never inside the engine. Identity comes from COORDINATOR_SEED
in backend/.env.local; with AGENTVERSE_API_KEY set the Agentverse mailbox is
created on startup with agent_type "mailbox", so no browser click is needed.

Run from backend/:  FETCH_CHAT=1 ENGINE_URL=http://127.0.0.1:8000 .venv/bin/python -m agents.asi_bureau
Stop with SIGINT (Ctrl-C) so the Almanac marks the agent inactive.
Env knobs: ENGINE_URL (http://127.0.0.1:8000), COORDINATOR_PORT (8120),
           ASI_MODEL (asi1-mini), AGENTVERSE_AUTOCONNECT (1), AGENTVERSE_TEAM.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND / ".env.local")
load_dotenv(BACKEND / ".env")

from uagents import Agent, Context, Model, Protocol  # noqa: E402
from uagents.mailbox import (  # noqa: E402
    AgentverseConnectRequest,
    register_in_agentverse,
)
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.registration import RegistrationRequest  # noqa: E402

from agents import planners  # noqa: E402

NAME = "PARALLEL Coordinator"
PORT = int(os.getenv("COORDINATOR_PORT", "8120"))
ENGINE_URL = os.getenv("ENGINE_URL", "http://127.0.0.1:8000").rstrip("/")
ASI_URL = "https://api.asi1.ai/v1/chat/completions"
ASI_MODEL = os.getenv("ASI_MODEL", "asi1-mini")
LLM_TIMEOUT_S = 8.0
ENGINE_TIMEOUT_S = 20.0
BRANCH_TICKS = 8

SEED = os.getenv("COORDINATOR_SEED")

README = BACKEND / "agents" / "COORDINATOR_README.md"
DESCRIPTION = (
    "Coordinates Energy, Transit and Repair-crew agents for the PARALLEL campus "
    "digital twin; answers storm what-ifs with simulator-tested options."
)

HELP_TEXT = (
    "I am the PARALLEL Coordinator for the campus power and transit twin. "
    "Describe a storm or an equipment failure and I will run it through the simulator "
    "and rank the response policies, with the Energy Planner, Transit Planner and "
    "Repair Crew each weighing in.\n"
    "Try: \"An ice storm hit North Campus\", \"A tornado touched down\", "
    "\"The power plant trips offline\".\n"
    "Then: \"adopt 1\" to apply an option, \"status\" for the live picture, "
    "\"reset\" to clear the campus."
)


# ------------------------------------------------------------------ engine client
class EngineError(Exception):
    pass


_http: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(base_url=ENGINE_URL, timeout=ENGINE_TIMEOUT_S)
    return _http


async def engine(method: str, path: str, body: dict | None = None) -> Any:
    try:
        r = await _client().request(method, path, json=body)
    except httpx.HTTPError as ex:
        raise EngineError(f"cannot reach the simulator at {ENGINE_URL} ({type(ex).__name__})") from ex
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except Exception:
            detail = r.text
        raise EngineError(f"{path}: {detail}")
    return r.json()


# --------------------------------------------------------------------- ASI:One
async def asi_chat(messages: list[dict], *, json_mode: bool = False, max_tokens: int = 200) -> str | None:
    """One ASI:One call, hard-capped at LLM_TIMEOUT_S overall. None on any failure."""
    key = os.getenv("ASI_ONE_API_KEY")
    if not key:
        return None
    body: dict[str, Any] = {
        "model": ASI_MODEL,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    async def _call() -> str:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_S) as c:
            r = await c.post(ASI_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
        r.raise_for_status()
        return (r.json()["choices"][0]["message"]["content"] or "").strip()

    try:
        out = await asyncio.wait_for(_call(), LLM_TIMEOUT_S)
        return out or None
    except Exception:
        return None


_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _numbers(text: str) -> set[float]:
    out = set()
    for m in _NUM.findall(text):
        try:
            out.add(float(m.replace(",", "")))
        except ValueError:
            pass
    return out


async def phrase(facts: str, fallback: str) -> tuple[str, str]:
    """Two-sentence headline from ASI:One using only FACTS; fallback if it strays.

    Returns (text, source). Any number in the model's text that is not in FACTS
    rejects the whole answer, so the headline can never contradict the simulator.
    """
    out = await asi_chat(
        [
            {
                "role": "system",
                "content": (
                    "You are the PARALLEL Coordinator for a university campus digital twin. "
                    "Write at most two plain sentences for an operations lead. Use ONLY the "
                    "numbers given in FACTS, never invent or round numbers, no lists, no markdown."
                ),
            },
            {"role": "user", "content": f"FACTS:\n{facts}"},
        ],
        max_tokens=140,
    )
    if out:
        out = " ".join(out.split())
        if _numbers(out) <= (_numbers(facts) | {1.0, 2.0, 3.0}):
            return out, ASI_MODEL
    return fallback, "template"


# ------------------------------------------------------------- scenario parsing
# Priority order matters: first match wins.
HAZARD_WORDS: list[tuple[str, list[str]]] = [
    ("tornado", ["tornado", "twister", "funnel cloud"]),
    ("ice_storm", ["ice storm", "ice", "freezing rain", "glaze"]),
    ("thunderstorm_wind", ["thunderstorm", "thunder storm", "derecho", "severe storm", "storm"]),
    ("heavy_snow", ["heavy snow", "snowstorm", "blizzard", "snow"]),
    ("extreme_heat", ["extreme heat", "heat wave", "heatwave", "heat"]),
    ("extreme_cold", ["extreme cold", "cold snap", "polar vortex", "freeze", "freezing", "cold"]),
    ("high_wind", ["high wind", "windstorm", "wind"]),
]
NODE_ALIASES = {
    "cpp": ["power plant", "central plant", "the plant", "cpp"],
    "north_switch": ["north switch", "switching station", "north feed", "north campus feed",
                     "north campus power", "north grid"],
    "uh": ["university hospital", "u hospital"],
    "mott": ["mott hospital", "childrens hospital", "children's hospital"],
    "fire_1": ["fire station"],
    "city_hall": ["city hall"],
}
NODE_STOP = {
    "campus", "university", "hall", "building", "center", "central", "station", "hospital",
    "school", "business", "north", "south", "health", "care", "laboratories", "commons",
    "transit", "city", "fire", "power", "plant", "switching", "undergraduate", "library",
    "children", "pavilion", "michigan", "mary", "research", "complex",
}


def _has(text: str, word: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", text) is not None


def keyword_parse(text: str, hazard_ids: set[str], nodes: list[dict]) -> dict:
    """Deterministic fallback: hazard words first, then node names."""
    t = text.lower().replace("’", "'")
    for hid, words in HAZARD_WORDS:
        if hid in hazard_ids and any(_has(t, w) for w in words):
            return {"intent": "scenario", "hazard_id": hid, "node_ids": []}
    for hid in hazard_ids:  # ids/names the table above does not know
        if _has(t, hid.replace("_", " ")):
            return {"intent": "scenario", "hazard_id": hid, "node_ids": []}
    # node aliases: full names, ids, hand aliases, then single distinctive words
    owners: dict[str, list[str]] = {}
    aliases: list[tuple[str, str]] = []
    for n in nodes:
        nid = n["id"]
        for a in [n["name"].lower(), nid, nid.replace("_", " ")] + NODE_ALIASES.get(nid, []):
            aliases.append((a, nid))
        for w in re.findall(r"[a-z']+", n["name"].lower()):
            if len(w) >= 4 and w not in NODE_STOP:
                owners.setdefault(w, []).append(nid)
    for w, ids in owners.items():
        if len(ids) == 1:
            aliases.append((w, ids[0]))
    hit: list[str] = []
    for a, nid in sorted(aliases, key=lambda p: -len(p[0])):
        if _has(t, a):
            t = t.replace(a, " ")  # do not double-match substrings of a longer alias
            if nid not in hit:
                hit.append(nid)
    if hit:
        return {"intent": "scenario", "hazard_id": None, "node_ids": hit}
    return {"intent": "other", "hazard_id": None, "node_ids": []}


ADOPT_RE = re.compile(
    r"\b(?:adopt|choose|pick|select|apply|take|go\s+with|use)\b[^0-9]{0,20}(\d)\b|\boption\s+(\d)\b"
)
STATUS_RE = re.compile(r"^\W*(status|how are we|where are we|sitrep|summary|what'?s (?:happening|going on)|update)\b")
RESET_RE = re.compile(r"^\W*(reset|start over|clear|restore all|back to normal)\b")
HELP_RE = re.compile(r"^\W*(help|\?|hi|hello|hey|what can you do|who are you|options\?*)\W*$")


async def asi_parse(text: str, hazards: list[dict], nodes: list[dict]) -> dict | None:
    hz = "; ".join(f"{h['id']} ({h.get('name', '')})" for h in hazards)
    nd = "; ".join(f"{n['id']} ({n['name']})" for n in nodes)
    out = await asi_chat(
        [
            {
                "role": "system",
                "content": (
                    "Convert one message to a campus power assistant into JSON only: "
                    '{"intent": "scenario"|"adopt"|"status"|"reset"|"help"|"other", '
                    '"hazard_id": string|null, "node_ids": [string], "option": integer|null}. '
                    "Use scenario when the user describes a storm or hazard or says equipment "
                    "failed or tripped. hazard_id must be one of HAZARDS, node_ids must be from "
                    "NODES, and use node_ids only when no hazard fits. Use other for gibberish "
                    f"or unrelated text.\nHAZARDS: {hz}\nNODES: {nd}"
                ),
            },
            {"role": "user", "content": text[:600]},
        ],
        json_mode=True,
        max_tokens=120,
    )
    if not out:
        return None
    try:
        j = json.loads(out[out.index("{"): out.rindex("}") + 1])
    except (ValueError, json.JSONDecodeError):
        return None
    return j if isinstance(j, dict) else None


async def parse_scenario(text: str, hazards: list[dict], nodes: list[dict]) -> tuple[dict, str]:
    hazard_ids = {h["id"] for h in hazards}
    node_ids = {n["id"] for n in nodes}
    j = await asi_parse(text, hazards, nodes)
    if j:
        intent = str(j.get("intent") or "other").lower()
        hid = j.get("hazard_id") if j.get("hazard_id") in hazard_ids else None
        nids = [x for x in (j.get("node_ids") or []) if isinstance(x, str) and x in node_ids]
        opt = j.get("option") if isinstance(j.get("option"), int) else None
        if intent == "scenario" and (hid or nids):
            return {"intent": "scenario", "hazard_id": hid, "node_ids": [] if hid else nids}, ASI_MODEL
        if intent in {"adopt", "status", "reset", "help"}:
            return {"intent": intent, "option": opt}, ASI_MODEL
    kw = keyword_parse(text, hazard_ids, nodes)
    return kw, "keywords"


# ---------------------------------------------------------------------- formatting
def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def option_line(o: dict) -> str:
    return (
        f"{o['rank']}. {o['label']} (proposed by {o['proposed_by']}): "
        f"{pct(o['essential_served'])} of essential load served, "
        f"{o['people_dark']:,} people dark, {o['people_relocated']:,} relocated."
    )


def repair_line(sess: Session) -> str | None:
    r = sess.repair
    if not r:
        return None
    n = len(sess.options) + 1
    return (
        f"{n}. Restore {r['name']} first (proposed by {planners.REPAIR}): about {r['people']:,} people "
        f"depend on it. Sent as a repair order, not run through the policy branches."
    )


def adopt_hint(sess: Session) -> str:
    n = len(sess.options)
    nums = [f'"adopt {i}"' for i in range(1, n + 1)]
    hint = "Reply " + ", ".join(nums[:-1]) + f" or {nums[-1]} to apply a policy"
    if sess.repair:
        hint += f', or "adopt {n + 1}" to send the repair crew'
    return hint + "."


def failed_names(state: dict) -> list[str]:
    return [n.get("name") or n["id"] for n in state.get("nodes", []) if n.get("failed")]


def systems_down(briefing: dict) -> list[str]:
    return [s["system"] for s in briefing.get("systems", []) if s.get("status") == "down"]


class Session:
    def __init__(self) -> None:
        self.options: list[dict] = []
        self.scenario: str = ""
        self.labels: dict[str, str] = {}
        self.repair: dict | None = None  # Repair Crew option, adoptable as the next number


SESSIONS: dict[str, Session] = {}


def session_for(sender: str) -> Session:
    return SESSIONS.setdefault(sender, Session())


async def specialist_lines(state: dict, briefing: dict) -> list[str]:
    tr = planners.transit_plan(briefing)
    rp = planners.repair_plan(state)
    return [f"{planners.TRANSIT}: {tr['text']}", f"{planners.REPAIR}: {rp['text']}"]


# -------------------------------------------------------------------------- flow
async def do_scenario(sess: Session, text: str, meta: dict) -> str:
    t0 = time.perf_counter()
    hazards_resp, state0 = await asyncio.gather(engine("GET", "/hazards"), engine("GET", "/state"))
    hazards = hazards_resp.get("hazards", [])
    nodes = state0.get("nodes", [])
    parsed, meta["parse_src"] = await parse_scenario(text, hazards, nodes)
    meta["parse_s"] = round(time.perf_counter() - t0, 2)
    if parsed["intent"] == "adopt":
        return await do_adopt(sess, parsed.get("option"), meta)
    if parsed["intent"] == "status":
        return await do_status(sess, meta)
    if parsed["intent"] == "reset":
        return await do_reset(sess, meta)
    if parsed["intent"] != "scenario":
        return "I could not map that to a campus scenario.\n" + HELP_TEXT

    if parsed.get("hazard_id"):
        applied = await engine("POST", "/hazards/apply", {"id": parsed["hazard_id"]})
        hz = applied.get("hazard", {})
        what = f"{hz.get('name', parsed['hazard_id'])} ({(hz.get('effect') or {}).get('label', 'applied')})"
    else:
        ids = parsed["node_ids"]
        names = {n["id"]: n["name"] for n in nodes}
        await engine("POST", "/disrupt", {"node_ids": ids, "action": "fail", "reason": "ASI:One"})
        what = "Failure of " + ", ".join(names.get(i, i) for i in ids)
    sess.scenario = what
    meta["scenario"] = what

    branch, briefing, state = await asyncio.gather(
        engine("POST", "/branch", {"ticks": BRANCH_TICKS}),
        engine("GET", "/briefing"),
        engine("GET", "/state"),
    )
    sess.labels.update({b["id"]: b["label"] for b in branch.get("branches", [])})
    sess.options = planners.rank_policies(branch, top=3)
    first = planners.repair_plan(state)["first"]
    sess.repair = {"node_id": first["id"], "name": first["name"], "people": first["people"]} if first else None
    if not sess.options:
        return f"Applied {what}, but the simulator returned no policies to compare."

    best = sess.options[0]
    facts = (
        f"Scenario applied: {what}. Each policy was simulated for {BRANCH_TICKS} ticks. "
        f"Best policy: {best['label']} serves {pct(best['essential_served'])} of essential load "
        f"with {best['people_dark']} people dark and {best['people_relocated']} relocated."
    )
    fallback = (
        f"{what} is applied. Best simulated policy is {best['label']}: "
        f"{pct(best['essential_served'])} of essential load served, {best['people_dark']:,} people dark."
    )
    headline, meta["phrase_src"] = await phrase(facts, fallback)
    spec = await specialist_lines(state, briefing)
    lines = [
        headline,
        f"Scenario applied: {what}. Policies simulated {BRANCH_TICKS} ticks ahead, ranked by essential load served, then people dark.",
        *(option_line(o) for o in sess.options),
        *([repair_line(sess)] if sess.repair else []),
        *spec,
        adopt_hint(sess),
    ]
    return "\n".join(lines)


async def do_adopt(sess: Session, n: int | None, meta: dict) -> str:
    if not sess.options:
        return 'There are no options on the table yet. Describe a scenario first, for example "An ice storm hit North Campus".'
    top = len(sess.options) + (1 if sess.repair else 0)
    if n is None:
        return f'Which option? Reply "adopt 1" to "adopt {top}".'
    if not 1 <= n <= top:
        return f'Pick an option between 1 and {top}, for example "adopt 1".'
    if n > len(sess.options):  # Repair Crew: restore the failed node
        r = sess.repair
        await engine("POST", "/disrupt", {"node_ids": [r["node_id"]], "action": "restore", "reason": "ASI:One"})
        meta["adopted"] = f"restore:{r['node_id']}"
        sess.repair = None
        lead = f"Adopted option {n}: restore {r['name']} (proposed by {planners.REPAIR})."
    else:
        opt = sess.options[n - 1]
        await engine("POST", "/strategy", {"strategy": opt["id"]})
        meta["adopted"] = opt["id"]
        lead = f"Adopted option {n}: {opt['label']} (proposed by {opt['proposed_by']})."
    state, briefing = await asyncio.gather(engine("GET", "/state"), engine("GET", "/briefing"))
    return await live_summary(lead, state, briefing)


async def live_summary(lead: str, state: dict, briefing: dict) -> str:
    s = state.get("summary", {})
    failed = failed_names(state)
    down = systems_down(briefing)
    displaced = int(briefing.get("displaced") or 0)
    sheltering = int(briefing.get("sheltering") or 0)
    policy = state.get("strategy")
    facts = (
        f"Policy in force: {policy}. Supply {s.get('supply'):g} kW, demand {s.get('demand'):g} kW, "
        f"deficit {s.get('deficit'):g} kW. Failed: {', '.join(failed) or 'none'}. "
        f"{displaced} people displaced, {sheltering} sheltering. Systems down: {', '.join(down) or 'none'}."
    )
    fallback = (
        f"Supply is {s.get('supply'):g} kW against demand of {s.get('demand'):g} kW, "
        f"with {displaced:,} people displaced."
    )
    headline, _ = await phrase(facts, fallback)
    out = [lead, headline] if lead else [headline]
    out += [
        f"Live: tick {s.get('tick')}, supply {s.get('supply'):g} kW, demand {s.get('demand'):g} kW, "
        f"deficit {s.get('deficit'):g} kW, policy in force: {policy}.",
        f"Failed: {', '.join(failed) or 'none'}. Systems down: {', '.join(down) or 'none'}. "
        f"People displaced: {displaced:,}.",
    ]
    if briefing.get("priority", {}).get("answer"):
        out.append(f"Priority: {briefing['priority']['answer']}")
    out.extend(await specialist_lines(state, briefing))
    return "\n".join(out)


async def do_status(sess: Session, meta: dict) -> str:
    state, briefing = await asyncio.gather(engine("GET", "/state"), engine("GET", "/briefing"))
    if not failed_names(state):
        s = state.get("summary", {})
        return (
            f"The campus is running normally at tick {s.get('tick')}: supply {s.get('supply'):g} kW "
            f"against demand {s.get('demand'):g} kW, nothing failed, policy in force: {state.get('strategy')}. "
            'Describe a storm or failure to run a scenario, for example "tornado".'
        )
    return await live_summary("", state, briefing)


async def do_reset(sess: Session, meta: dict) -> str:
    await engine("POST", "/reset")
    sess.options, sess.scenario, sess.repair = [], "", None
    state = await engine("GET", "/state")
    s = state.get("summary", {})
    return (
        f"Campus reset. Supply {s.get('supply'):g} kW, demand {s.get('demand'):g} kW, "
        f"{len(failed_names(state))} failed nodes, policy in force: {state.get('strategy')}."
    )


async def handle_text(text: str, sender: str = "local") -> tuple[str, dict]:
    """The whole chat flow. Never raises; returns (reply, meta)."""
    meta: dict[str, Any] = {}
    sess = session_for(sender)
    t = text.strip()
    low = t.lower()
    t0 = time.perf_counter()
    try:
        m = ADOPT_RE.search(low)
        if HELP_RE.match(low):
            meta["route"] = "help"
            reply = HELP_TEXT
        elif RESET_RE.match(low):
            meta["route"] = "reset"
            reply = await do_reset(sess, meta)
        elif sess.options and "option" in low and not m and len(low.split()) <= 6:
            meta["route"] = "options"
            reply = "\n".join([f"Options from {sess.scenario}:", *(option_line(o) for o in sess.options),
                               *([repair_line(sess)] if sess.repair else []), adopt_hint(sess)])
        elif STATUS_RE.match(low):
            meta["route"] = "status"
            reply = await do_status(sess, meta)
        elif m and len(low.split()) <= 8:
            meta["route"] = "adopt"
            reply = await do_adopt(sess, int(m.group(1) or m.group(2)), meta)
        else:
            meta["route"] = "scenario"
            reply = await do_scenario(sess, t, meta)
    except EngineError as ex:
        meta["error"] = str(ex)
        reply = f"The simulator did not accept that: {ex}."
    except Exception as ex:  # keep the chat alive no matter what
        meta["error"] = f"{type(ex).__name__}: {ex}"
        reply = f"Something went wrong ({type(ex).__name__}). Try \"status\" or \"reset\"."
    meta["total_s"] = round(time.perf_counter() - t0, 2)
    return reply, meta


# ------------------------------------------------------------------ uAgent plumbing
if __name__ == "__main__":
    if os.getenv("FETCH_CHAT") != "1":
        sys.exit("Fetch.ai chat is off. Start it with FETCH_CHAT=1 (see docs/fetch.md).")
    if not SEED:
        sys.exit("COORDINATOR_SEED is not set (backend/.env.local)")

agent = Agent(
    name=NAME,
    seed=SEED or "parallel-coordinator-import-only",
    port=PORT,
    mailbox=True,
    description=DESCRIPTION,
    readme_path=str(README) if README.exists() else None,
    publish_agent_details=True,
    metadata={"tags": ["innovationlab", "hackathon"]},
)

chat = Protocol(spec=chat_protocol_spec)


def reply_message(text: str, end: bool = False) -> ChatMessage:
    content: list = [TextContent(text=text)]
    if end:
        content.append(EndSessionContent())
    return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(), content=content)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    t_recv = time.perf_counter()
    # Acknowledge first, as the protocol expects.
    await ctx.send(
        sender,
        ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id),
    )
    if any(isinstance(c, StartSessionContent) for c in msg.content):
        ctx.logger.info(f"session start from {sender}")
    text = msg.text().strip()
    if not text:
        return
    reply, meta = await handle_text(text, sender)
    await ctx.send(sender, reply_message(reply))
    ctx.logger.info(
        f"chat from {sender[:20]}.. handler={time.perf_counter() - t_recv:.2f}s "
        f"meta={json.dumps(meta)} text={text[:60]!r}"
    )


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"ack from {sender[:16]}... for {msg.acknowledged_msg_id}")


agent.include(chat, publish_manifest=True)


class Health(Model):
    name: str
    address: str
    port: int
    engine_url: str
    mailbox: bool
    agentverse_connected: bool
    agentverse_detail: str


_av_state = {"connected": False, "detail": "not attempted"}


@agent.on_rest_get("/health", Health)
async def health(_ctx: Context) -> Health:
    return Health(
        name=NAME,
        address=agent.address,
        port=PORT,
        engine_url=ENGINE_URL,
        mailbox=agent.mailbox_client is not None,
        agentverse_connected=_av_state["connected"],
        agentverse_detail=_av_state["detail"],
    )


async def agentverse_autoconnect(ctx: Context) -> None:
    """Create/refresh the Agentverse mailbox with the API key (no browser)."""
    key = os.getenv("AGENTVERSE_API_KEY")
    if os.getenv("AGENTVERSE_AUTOCONNECT", "1") != "1":
        _av_state["detail"] = "disabled by AGENTVERSE_AUTOCONNECT"
        return
    if not key:
        _av_state["detail"] = "AGENTVERSE_API_KEY missing; click Connect -> Mailbox in the inspector"
        ctx.logger.warning(_av_state["detail"])
        return
    t0 = time.perf_counter()
    details = RegistrationRequest(
        address=agent.address,
        name=NAME,
        agent_type="mailbox",
        profile=agent._build_registration_profile(),
        endpoints=agent._endpoints,
        protocols=list(agent.protocols.keys()),
        metadata=agent.metadata,
    )
    try:
        res = await asyncio.wait_for(
            register_in_agentverse(
                request=AgentverseConnectRequest(
                    user_token=key,
                    agent_type="mailbox",
                    team=os.getenv("AGENTVERSE_TEAM") or None,
                ),
                identity=agent._identity,
                prefix=agent._prefix,
                agentverse=agent.agentverse,
                agent_details=details,
            ),
            timeout=20,
        )
        _av_state["connected"] = bool(res.success)
        _av_state["detail"] = res.detail or ("ok" if res.success else "failed")
    except Exception as ex:
        _av_state["detail"] = f"{type(ex).__name__}: {ex}"
    ctx.logger.info(
        f"Agentverse autoconnect: success={_av_state['connected']} "
        f"detail={_av_state['detail']!r} in {time.perf_counter() - t0:.2f}s"
    )


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(
        f"{NAME} address={agent.address} port={PORT} engine={ENGINE_URL} model={ASI_MODEL}"
    )
    await agentverse_autoconnect(ctx)


if __name__ == "__main__":
    agent.run()
