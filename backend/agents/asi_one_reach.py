"""
L4 check: ask ASI:One (API, planner mode) to talk to the PARALLEL Coordinator by
address, i.e. "reached from ASI:One" without a browser.

Run from backend/ with the coordinator running:
  .venv/bin/python -m agents.asi_one_reach "An ice storm hit North Campus, what should we do?"
Prints streamed chunks with timestamps; check the coordinator log for
"chat from ..." lines whose sender is not our test client.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND / ".env.local")

from uagents_core.identity import Identity  # noqa: E402

ADDRESS = os.getenv("COORDINATOR_ADDRESS") or Identity.from_seed(os.environ["COORDINATOR_SEED"], 0).address
prompt = sys.argv[1] if len(sys.argv) > 1 else "echo: hello from ASI:One planner"
model = os.getenv("ASI_PLANNER_MODEL", "asi1")
session = str(uuid.uuid4())

body = {
    "model": model,
    "messages": [{"role": "user", "content": f"Ask the PARALLEL Coordinator agent ({ADDRESS}): {prompt}"}],
    "planner_mode": True,
    "agents": [ADDRESS],
    "stream": True,
}
headers = {"Authorization": f"Bearer {os.environ['ASI_ONE_API_KEY']}", "x-session-id": session}
print(f"session={session} model={model} agent={ADDRESS}")
t0 = time.perf_counter()
text = []
with httpx.stream("POST", "https://api.asi1.ai/v1/chat/completions", headers=headers, json=body,
                  timeout=httpx.Timeout(120, read=120)) as r:
    print("HTTP", r.status_code)
    for line in r.iter_lines():
        if not line:
            continue
        dt = time.perf_counter() - t0
        if line.startswith("data: "):
            data = line[6:]
            if data.strip() == "[DONE]":
                print(f"[{dt:6.2f}s] [DONE]")
                break
            try:
                j = json.loads(data)
            except json.JSONDecodeError:
                print(f"[{dt:6.2f}s] raw {data[:300]}")
                continue
            ch = (j.get("choices") or [{}])[0]
            delta = (ch.get("delta") or {}).get("content")
            extra = {k: v for k, v in j.items() if k not in ("choices", "id", "object", "created", "model")}
            if delta:
                text.append(delta)
            if extra or not delta:
                print(f"[{dt:6.2f}s] {json.dumps(extra)[:600] if extra else json.dumps(ch)[:300]}")
        else:
            print(f"[{dt:6.2f}s] {line[:400]}")
print(f"--- final text ({time.perf_counter() - t0:.2f}s) ---")
print("".join(text)[:3000])
