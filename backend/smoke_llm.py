"""
Live check of the LLM fallback chains. Spends a few cents of real API calls.

  1. Each provider is called directly with a tiny prompt: ok / latency.
  2. For each failure drill (one provider given a bad key or a dead URL, the
     others untouched) a private engine is started on port 8621 and these must
     still answer: POST /command, /plans, /verdict, and the Fetch.ai
     coordinator's parse + headline.

Run from backend/:   .venv/bin/python smoke_llm.py [--direct-only] [words to pick drills, e.g. grok claude]
Keys are read from .env.local and never printed.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent
load_dotenv(BACKEND / ".env.local")
import uagents  # noqa: E402


async def _no_publish(self, *args, **kwargs) -> None:
    """Importing the coordinator must not publish its manifest to Agentverse."""


uagents.Agent.publish_manifest = _no_publish
PORT = 8621
BASE = f"http://127.0.0.1:{PORT}"
DEAD = "http://127.0.0.1:9/dead"

# (label, env overrides applied to the engine and to this process)
DRILLS = [
    ("all providers healthy", {}),
    ("Grok bad key", {"XAI_API_KEY": "bogus-key"}),
    ("Grok endpoint dead", {"LLM_GROK_URL": DEAD}),
    ("Claude bad key", {"ANTHROPIC_API_KEY": "bogus-key"}),
    ("ASI:One bad key", {"ASI_ONE_API_KEY": "bogus-key"}),
    ("Grok + ASI:One dead (only Claude left)", {"XAI_API_KEY": "bogus-key", "ASI_ONE_API_KEY": "bogus-key"}),
]


async def direct() -> None:
    import llm

    print("== direct provider calls ==")
    for name in ("grok", "asi", "claude", "gemini"):
        if not llm.configured(name):
            print(f"  {name:7s} not configured")
            continue
        started = time.perf_counter()
        got = await llm.complete_json('Say hello.', 'Reply with {"ok": true}.', providers=[name], timeout=15, total_timeout=15, label="smoke")
        dt = time.perf_counter() - started
        print(f"  {name:7s} {'ok  ' if got else 'FAIL'} {dt:5.1f}s")
        llm.reset_state()


ENGINE_LOG = BACKEND / ".smoke_engine.log"  # engine output for one drill; deleted at the end


def start_engine(env: dict[str, str]) -> subprocess.Popen:
    full = {**os.environ, "STDB_ENABLED": "0", "FETCH_CHAT": "0", **env}
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=BACKEND, env=full, stdout=subprocess.DEVNULL, stderr=ENGINE_LOG.open("w"),
    )


def engine_notes(everything: bool = False) -> None:
    """Which provider answered or failed inside the engine; the whole log when a drill failed."""
    try:
        lines = ENGINE_LOG.read_text().splitlines()
    except OSError:
        return
    for line in lines:
        if everything or "parallel.llm" in line:
            print("    engine:", line[:220])


async def wait_port_free() -> None:
    """The previous drill's engine can take a moment to let go of the port."""
    async with httpx.AsyncClient(timeout=1) as c:
        for _ in range(40):
            try:
                await c.get(BASE + "/")
            except httpx.HTTPError:
                return
            await asyncio.sleep(0.5)


async def wait_ready(proc: subprocess.Popen) -> bool:
    async with httpx.AsyncClient(timeout=2) as c:
        for _ in range(60):
            if proc.poll() is not None:
                return False
            try:
                if (await c.get(BASE + "/")).status_code == 200:
                    return True
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
    return False


async def timed(label: str, coro) -> tuple[str, float, object]:
    started = time.perf_counter()
    try:
        out = await coro
    except Exception as exc:  # noqa: BLE001
        out = f"EXC {type(exc).__name__}"
    return label, time.perf_counter() - started, out


async def drill(label: str, env: dict[str, str]) -> bool | None:
    print(f"\n== {label} ==")
    await wait_port_free()
    proc = start_engine(env)
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        if not await wait_ready(proc):
            print("  engine did not start")
            return False
        import llm
        from agents import asi_bureau

        llm.reset_state()
        results: list[tuple[str, float, str]] = []
        async with httpx.AsyncClient(base_url=BASE, timeout=120) as c:
            started = time.perf_counter()
            r = await c.post("/command", json={"text": "The central power plant just failed"})
            body = r.json()
            ok = r.status_code == 200 and bool(body.get("policy", {}).get("action"))
            results.append(("/command", time.perf_counter() - started,
                            f"{'ok' if ok else 'FAIL'} {r.status_code} parser={body.get('policy', {}).get('parser')} action={body.get('policy', {}).get('action')}"))

            hazards = (await c.get("/hazards")).json().get("hazards", [])
            nodes = (await c.get("/state")).json().get("nodes", [])

            async def plans():
                started = time.perf_counter()
                r = await c.post("/plans")
                b = r.json()
                good = r.status_code == 200 and len(b.get("plans", [])) >= 1
                return ("/plans", time.perf_counter() - started, f"{'ok' if good else 'FAIL'} {r.status_code} model={b.get('model')} plans={len(b.get('plans', []))}")

            async def verdict():
                started = time.perf_counter()
                r = await c.post("/verdict", json={"season": "summer", "shelter": "cooling", "winner": "people", "policies": [
                    {"id": "people", "label": "People first", "people_dark": 0, "people_in_shelter": 1800, "people_relocated": 400, "shelter_kw": 2100},
                    {"id": "even", "label": "Even split", "people_dark": 300, "people_in_shelter": 1200, "people_relocated": 100, "shelter_kw": 1500}]})
                b = r.json()
                good = r.status_code == 200 and bool(b.get("paragraph"))
                return ("/verdict", time.perf_counter() - started, f"{'ok' if good else 'FAIL'} {r.status_code} source={b.get('source')} model={b.get('model', '-')}")

            async def coordinator():
                started = time.perf_counter()
                parsed, src = await asi_bureau.parse_scenario("An ice storm hit North Campus, what should we do?", hazards, nodes)
                good = parsed.get("intent") == "scenario"
                head, hsrc = await asi_bureau.phrase("Best policy: People first serves 91.5% of essential load with 12 people dark.", "template headline")
                return ("coordinator", time.perf_counter() - started, f"{'ok' if good else 'FAIL'} parse={parsed.get('hazard_id') or parsed.get('node_ids')} via {src}; headline via {hsrc}")

            for entry in await asyncio.gather(plans(), verdict(), coordinator(), return_exceptions=True):
                results.append(entry if isinstance(entry, tuple) else ("error", 0.0, f"FAIL {type(entry).__name__}: {entry}"))
        for name, dt, text in results:
            print(f"  {name:12s} {dt:5.1f}s  {text}")
        good = all(" FAIL" not in f" {t}" and not t.startswith("FAIL") for _, _, t in results)
        if not good and proc.poll() is not None:
            # Another session on this machine stopped our engine mid-drill; that says nothing about the chains.
            print("  engine was stopped from outside during the drill; running it again")
            return None
        engine_notes(everything=not good)
        return good
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


async def main() -> int:
    await direct()
    if "--direct-only" in sys.argv:
        return 0
    sys.path.insert(0, str(BACKEND))
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    drills = [d for d in DRILLS if not only or any(word.lower() in d[0].lower() for word in only)]
    failed = []
    for label, env in drills:
        ok = await drill(label, env)
        if ok is None:  # engine killed from outside: one more try
            ok = await drill(label, env)
        if not ok:
            failed.append(label)
    if "--keep-log" not in sys.argv:
        ENGINE_LOG.unlink(missing_ok=True)
    print("\nALL DRILLS ANSWERED" if not failed else f"\nFAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(asyncio.run(main()))
