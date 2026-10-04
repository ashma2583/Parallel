"""
Scripted test client for the PARALLEL Coordinator (Agent Chat Protocol).

Runs 8 conversations against a running coordinator and a running engine, checks
the replies AND the engine state they should have caused, and times each step:

  1 ice storm on North Campus   5 adopt 1 after a scenario
  2 tornado                     6 adopt 2 after a scenario
  3 power plant trips + adopt 4 (repair crew restores it)   7 reset
  4 status                      8 nonsense (must not touch the campus)

Routes:
  local    - straight to http://127.0.0.1:<coordinator-port>/submit, no Agentverse
             on the way in.
  mailbox  - default Almanac resolution -> Agentverse mailbox -> coordinator polls
             it (what ASI:One and other Agentverse senders use).
Replies always come back by Almanac lookup of this client's local endpoint.

Run from backend/ with the coordinator and the engine already running:
  ENGINE_URL=http://127.0.0.1:8350 .venv/bin/python -m agents.chat_test_client --route local
  ENGINE_URL=http://127.0.0.1:8350 .venv/bin/python -m agents.chat_test_client --route mailbox --cases 1,5
Exit code 0 only if every step passed. This resets the engine between cases.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND / ".env.local")
load_dotenv(BACKEND / ".env")

from uagents import Agent, Context, Protocol  # noqa: E402
from uagents.resolver import RulesBasedResolver  # noqa: E402
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.identity import Identity  # noqa: E402

from agents import planners  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--route", choices=["local", "mailbox"], default="local")
p.add_argument("--cases", default="1,2,3,4,5,6,7,8", help="comma list of case numbers")
p.add_argument("--port", type=int, default=8131)
p.add_argument("--coordinator-port", type=int, default=8130)
p.add_argument("--timeout", type=float, default=45.0)
p.add_argument("--engine-url", default=os.getenv("ENGINE_URL", "http://127.0.0.1:8000"))
p.add_argument("--out", default="")
args = p.parse_args()
ENGINE = args.engine_url.rstrip("/")

COORD_ADDRESS = os.getenv("COORDINATOR_ADDRESS") or Identity.from_seed(
    os.environ["COORDINATOR_SEED"], 0
).address
CLIENT_SEED = os.getenv("CHAT_TEST_CLIENT_SEED", "parallel-chat-test-client-dev-seed-v1")

resolver = None
if args.route == "local":
    resolver = RulesBasedResolver(
        {COORD_ADDRESS: f"http://127.0.0.1:{args.coordinator_port}/submit"}
    )

client = Agent(
    name="parallel_chat_test_client",
    seed=CLIENT_SEED,
    port=args.port,
    endpoint=[f"http://127.0.0.1:{args.port}/submit"],
    resolve=resolver,
    enable_agent_inspector=False,
    publish_agent_details=False,
)

proto = Protocol(spec=chat_protocol_spec)
pending: dict[str, dict] = {}
EXIT_CODE = {"v": 1}


@proto.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    cur = pending.get("current")
    if cur and str(msg.acknowledged_msg_id) == cur["msg_id"] and not cur["ack"].done():
        cur["ack"].set_result(time.perf_counter())


@proto.on_message(ChatMessage)
async def on_reply(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(
        sender,
        ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id),
    )
    cur = pending.get("current")
    if cur and not cur["reply"].done():
        cur["reply"].set_result((time.perf_counter(), msg.text()))


client.include(proto)


# ------------------------------------------------------------------ engine helpers
async def eng(method: str, path: str, body: dict | None = None):
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.request(method, f"{ENGINE}{path}", json=body)
    r.raise_for_status()
    return r.json()


async def failed_ids() -> list[str]:
    st = await eng("GET", "/state")
    return [n["id"] for n in st["nodes"] if n.get("failed")]


async def expected_ranking() -> list[dict]:
    return planners.rank_policies(await eng("POST", "/branch", {"ticks": 8}), top=3)


def n_options(reply: str) -> int:
    return len(re.findall(r"^[123]\. .+\(proposed by .+\)", reply, flags=re.M))


def has_specialists(reply: str) -> bool:
    return all(s in reply for s in (planners.ENERGY, planners.TRANSIT, planners.REPAIR))


# ------------------------------------------------------------------------ checks
# Each check returns (ok, note). `ctx` carries values between the steps of a case.
async def chk_ice(reply, c):
    failed = await failed_ids()
    exp = await expected_ranking()
    c["exp"] = exp
    top = exp[0]
    line1 = next((l for l in reply.splitlines() if l.startswith("1. ")), "")
    ok = (
        "ice storm" in reply.lower()
        and n_options(reply) == 3
        and has_specialists(reply)
        and "students" in reply.lower()
        and "north_switch" in failed
        and top["label"] in line1
        and f"{top['essential_served'] * 100:.1f}%" in line1
    )
    return ok, f"failed={failed} top={top['id']} {top['essential_served']:.4f}"


async def chk_tornado(reply, c):
    failed = await failed_ids()
    ok = "tornado" in reply.lower() and n_options(reply) == 3 and {"north_switch", "ncrc"} <= set(failed)
    return ok, f"failed={failed}"


async def chk_plant(reply, c):
    failed = await failed_ids()
    ok = "central power plant" in reply.lower() and n_options(reply) == 3 and "cpp" in failed
    return ok, f"failed={failed}"


async def chk_status(reply, c):
    ok = "Live:" in reply and "North Campus Switching Station" in reply and "Repair Crew" in reply
    return ok, reply.splitlines()[1][:90] if len(reply.splitlines()) > 1 else reply[:90]


async def chk_repair(reply, c):
    failed = await failed_ids()
    ok = "Adopted option 4" in reply and "Repair Crew" in reply and "cpp" not in failed and "Live:" in reply
    return ok, f"failed after restore={failed}"


def chk_adopt(n):
    async def _chk(reply, c):
        st = await eng("GET", "/state")
        want = c["exp"][n - 1]["id"]
        ok = f"Adopted option {n}" in reply and st["strategy"] == want and "Live:" in reply
        return ok, f"engine strategy={st['strategy']} expected={want}"
    return _chk


async def chk_reset(reply, c):
    failed = await failed_ids()
    return "Campus reset" in reply and failed == [], f"failed={failed}"


async def chk_nonsense(reply, c):
    failed = await failed_ids()
    ok = failed == [] and "could not map" in reply.lower() and "adopt" in reply.lower()
    return ok, f"failed={failed}"


ICE = "An ice storm hit North Campus, what should we do?"
CASES = {
    1: ("ice storm North Campus", [(ICE, chk_ice)]),
    2: ("tornado", [("A tornado touched down near North Campus", chk_tornado)]),
    3: ("power plant trips + repair", [("The central power plant just tripped offline", chk_plant),
                                       ("adopt 4", chk_repair)]),
    4: ("status", [(ICE, chk_ice), ("status", chk_status)]),
    5: ("adopt 1", [(ICE, chk_ice), ("adopt 1", chk_adopt(1))]),
    6: ("adopt 2", [(ICE, chk_ice), ("adopt 2", chk_adopt(2))]),
    7: ("reset", [(ICE, chk_ice), ("reset", chk_reset)]),
    8: ("nonsense", [("asdf qwerty blorp zzzz", chk_nonsense)]),
}


# ------------------------------------------------------------------------ runner
async def wait_registered(limit: float = 30.0) -> float:
    """Wait until the Almanac API lists our local endpoint (needed for replies)."""
    t0 = time.perf_counter()
    url = f"https://agentverse.ai/v1/almanac/agents/{client.address}"
    async with httpx.AsyncClient(timeout=5) as http:
        while time.perf_counter() - t0 < limit:
            try:
                r = await http.get(url)
                if r.status_code == 200 and any(
                    e["url"].endswith(f":{args.port}/submit") for e in r.json().get("endpoints", [])
                ):
                    return time.perf_counter() - t0
            except Exception:
                pass
            await asyncio.sleep(0.5)
    return -1.0


async def send_and_wait(ctx: Context, text: str) -> dict:
    loop = asyncio.get_running_loop()
    msg = ChatMessage(content=[TextContent(text=text)])
    cur = {"msg_id": str(msg.msg_id), "ack": loop.create_future(), "reply": loop.create_future()}
    pending["current"] = cur
    t0 = time.perf_counter()
    status = await ctx.send(COORD_ADDRESS, msg)
    rec = {"text": text, "send_status": str(getattr(status, "status", status))}
    try:
        t_reply, reply = await asyncio.wait_for(cur["reply"], args.timeout)
        rec.update(got_reply=True, reply_s=round(t_reply - t0, 2), reply=reply)
    except asyncio.TimeoutError:
        rec.update(got_reply=False, reply_s=None, reply="")
    rec["ack_s"] = round(cur["ack"].result() - t0, 2) if cur["ack"].done() else None
    return rec


async def run_suite(ctx: Context):
    reg_s = await wait_registered()
    ctx.logger.info(
        f"client {client.address} almanac-visible after {reg_s:.2f}s; route={args.route} "
        f"engine={ENGINE} -> {COORD_ADDRESS}"
    )
    results = []
    try:
        for num in [int(x) for x in args.cases.split(",") if x.strip()]:
            name, steps = CASES[num]
            await eng("POST", "/reset")
            c: dict = {}
            for text, check in steps:
                rec = await send_and_wait(ctx, text)
                if rec["got_reply"]:
                    try:
                        ok, note = await check(rec["reply"], c)
                    except Exception as ex:
                        ok, note = False, f"check error {type(ex).__name__}: {ex}"
                else:
                    ok, note = False, "no reply before timeout"
                rec.update(case=num, name=name, ok=bool(ok), note=note)
                results.append(rec)
                ctx.logger.info(
                    f"case {num} [{name}] {'PASS' if ok else 'FAIL'} ack={rec['ack_s']}s "
                    f"reply={rec['reply_s']}s | {text[:40]!r} | {note}"
                )
                if not ok:
                    ctx.logger.info("reply was: " + rec["reply"][:600].replace("\n", " | "))
                    break  # later steps of this case depend on this one
                await asyncio.sleep(0.2)
    finally:
        try:
            await eng("POST", "/reset")  # leave the engine clean
        except Exception:
            pass
        lat = sorted(r["reply_s"] for r in results if r.get("reply_s") is not None)
        cases_run = sorted({r["case"] for r in results})
        passed = [n for n in cases_run if all(r["ok"] for r in results if r["case"] == n)
                  and len([r for r in results if r["case"] == n]) == len(CASES[n][1])]
        summary = {
            "route": args.route, "engine": ENGINE, "cases_run": cases_run, "cases_passed": passed,
            "steps": len(results), "steps_ok": sum(r["ok"] for r in results),
            "almanac_visible_s": round(reg_s, 2),
        }
        if lat:
            summary.update(
                median_reply_s=round(statistics.median(lat), 2),
                p95_reply_s=lat[min(len(lat) - 1, int(round(0.95 * (len(lat) - 1))))],
                max_reply_s=lat[-1],
            )
        ctx.logger.info("SUMMARY " + json.dumps(summary))
        if args.out:
            Path(args.out).write_text(json.dumps({"summary": summary, "steps": results}, indent=1))
        EXIT_CODE["v"] = 0 if results and passed == cases_run and len(passed) == len(
            [int(x) for x in args.cases.split(",") if x.strip()]) else 1
        os.kill(os.getpid(), signal.SIGINT)


@client.on_event("startup")
async def start(ctx: Context):
    asyncio.get_running_loop().create_task(run_suite(ctx))


if __name__ == "__main__":
    client.run()
    sys.exit(EXIT_CODE["v"])
