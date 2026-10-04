"""
PARALLEL - SpacetimeDB engine side for Phase 5 (multiplayer).

Browsers enqueue commands with the `request_action` reducer (WebSocket SDK).
The engine:

  1. gets a stable identity token (POST /v1/identity, cached in a 0600 file),
  2. takes the engine lock with the `claim_engine` reducer,
  3. polls `SELECT * FROM action WHERE status = 'pending'` over HTTP SQL,
  4. acks each action `running`, runs it by calling its OWN FastAPI routes
     in-process (httpx.ASGITransport), then acks `done` / `error`.

Duplicates are prevented twice: the `running` ack is a compare-and-set in the
module (`ack_actions` fails the whole batch if any row is no longer pending, so
two engine processes sharing an identity cannot both take an action), and an
in-memory set of processed ids. Actions found in
`running` at startup were interrupted by an engine restart and are marked
`error` instead of being re-run.

Nothing here raises into the sim loop: every network failure is logged,
counted, and retried on the next poll.

Configuration (environment variables, all optional):
    STDB_URL              default "http://127.0.0.1:3000"
    STDB_DATABASE         default "parallel"
    STDB_TIMEOUT          seconds per request, default "2"
    STDB_ENGINE_TOKEN_FILE  default "backend/.stdb_engine_token" (keep it out of git)
    STDB_POLL_SECONDS     default "0.3"
    STDB_KEEP_ACTIONS     finished actions kept in the table, default "200"
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

log = logging.getLogger("parallel.stdb_actions")

_DEFAULT_TOKEN_FILE = Path(__file__).with_name(".stdb_engine_token")


# --------------------------------------------------------------------------- #
# HTTP client with a persistent identity
# --------------------------------------------------------------------------- #

class StdbHttp:
    """Minimal SpacetimeDB HTTP client: identity, reducer calls, SQL."""

    def __init__(
        self,
        base_url: str | None = None,
        database: str | None = None,
        token_file: str | Path | None = None,
        timeout: float | None = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("STDB_URL", "http://127.0.0.1:3000")).rstrip("/")
        self.database = database or os.getenv("STDB_DATABASE", "parallel")
        self.timeout = timeout if timeout is not None else float(os.getenv("STDB_TIMEOUT", "2"))
        tf = token_file or os.getenv("STDB_ENGINE_TOKEN_FILE") or _DEFAULT_TOKEN_FILE
        self.token_file = Path(tf)
        self.token: str | None = None
        self.identity: str | None = None
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)
        if self.token is None:
            await self._load_or_create_token()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _load_or_create_token(self) -> None:
        assert self._client is not None
        if self.token_file.exists():
            try:
                data = json.loads(self.token_file.read_text())
                self.token, self.identity = data["token"], data["identity"]
                return
            except Exception:  # noqa: BLE001 - corrupt file: mint a new identity
                log.warning("ignoring unreadable token file %s", self.token_file)
        resp = await self._client.post("/v1/identity")
        resp.raise_for_status()
        data = resp.json()
        self.token, self.identity = data["token"], data["identity"]
        try:
            self.token_file.write_text(json.dumps({"identity": self.identity, "token": self.token}))
            os.chmod(self.token_file, 0o600)
        except OSError as exc:
            log.warning("could not persist engine token to %s: %s", self.token_file, exc)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def call(self, reducer: str, args: list[Any]) -> tuple[int, str]:
        """POST /call/<reducer>. Returns (status, body). 530 = SenderError."""
        if self._client is None:
            await self.start()
        assert self._client is not None
        resp = await self._client.post(
            f"/v1/database/{self.database}/call/{reducer}", json=args, headers=self._headers()
        )
        return resp.status_code, resp.text

    async def sql(self, query: str) -> list[dict[str, Any]]:
        """POST /sql. Returns rows of the last statement as dicts keyed by column."""
        if self._client is None:
            await self.start()
        assert self._client is not None
        resp = await self._client.post(
            f"/v1/database/{self.database}/sql", content=query, headers=self._headers()
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"sql {resp.status_code}: {resp.text[:300]}")
        results = resp.json()
        return parse_sql_result(results[-1]) if results else []


def _decode(value: Any, algebraic_type: dict[str, Any]) -> Any:
    """Flatten the SATS-JSON wrappers the SQL endpoint uses for special types."""
    product = algebraic_type.get("Product")
    if product and isinstance(value, list) and len(product.get("elements", [])) == 1:
        inner = (product["elements"][0].get("name") or {}).get("some", "")
        if inner in ("__identity__", "__connection_id__", "__timestamp_micros_since_unix_epoch__"):
            return value[0]
    return value


def parse_sql_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    elements = result["schema"]["elements"]
    names = [(e.get("name") or {}).get("some", f"col{i}") for i, e in enumerate(elements)]
    types = [e["algebraic_type"] for e in elements]
    return [
        {n: _decode(v, ty) for n, v, ty in zip(names, row, types)}
        for row in result["rows"]
    ]


# --------------------------------------------------------------------------- #
# Dispatch: action kind -> engine route (in-process)
# --------------------------------------------------------------------------- #

# One line per kind. The action payload (JSON object) is the request body,
# optionally reshaped. New endpoints (/heat-wave, /clock ...) are one line.
KIND_ROUTES: dict[str, tuple[str, str, Callable[[dict], dict] | None]] = {
    "disrupt": ("POST", "/disrupt", None),
    "fail_node": ("POST", "/disrupt", lambda p: {**p, "action": "fail"}),
    "restore_node": ("POST", "/disrupt", lambda p: {**p, "action": "restore"}),
    "reset": ("POST", "/reset", None),
    "tick": ("POST", "/tick", None),
    "strategy": ("POST", "/strategy", None),          # adopt policy
    "priority": ("POST", "/priority", None),
    "hazard": ("POST", "/hazards/apply", None),
    "weather": ("POST", "/weather/apply", None),
    "branch": ("POST", "/branch", None),
    "storm_start": ("POST", "/storms/start", None),
    "storm_hit": ("POST", "/storms/hit", None),
    "storm_end": ("POST", "/storms/end", None),
    "suspend_line": ("POST", "/storms/routes/suspend", None),
    "restore_line": ("POST", "/storms/routes/restore", None),
    "scenario_run": ("POST", "/storms/scenario/run", None),
    "scenario_clear": ("POST", "/storms/scenario/clear", None),
}

Dispatch = Callable[[str, dict], Awaitable[dict]]


def asgi_dispatcher(app: Any, routes: dict | None = None, timeout: float = 30.0) -> Dispatch:
    """Run actions against the engine's own FastAPI app without a network hop."""
    table = routes or KIND_ROUTES
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://engine.local", timeout=timeout
    )

    async def dispatch(kind: str, payload: dict) -> dict:
        if kind not in table:
            raise ValueError(f"unknown action kind {kind!r}")
        method, path, shape = table[kind]
        body = shape(payload) if shape else payload
        resp = await client.request(method, path, json=body if method != "GET" else None)
        if resp.status_code >= 400:
            raise RuntimeError(f"{path} -> {resp.status_code}: {resp.text[:200]}")
        try:
            data = resp.json()
        except ValueError:
            data = {}
        return {"route": path, "status_code": resp.status_code, "body": data}

    return dispatch


def _short_result(out: dict) -> str:
    """Keep action.result small: route + status + a few headline numbers."""
    body = out.get("body") or {}
    summary = body.get("summary") if isinstance(body, dict) else None
    keep: dict[str, Any] = {"route": out.get("route"), "status_code": out.get("status_code")}
    if isinstance(summary, dict):
        keep["summary"] = {k: summary[k] for k in ("deficit", "power_ratio", "status_counts") if k in summary}
    if isinstance(body, dict) and "tick" in body:
        keep["tick"] = body["tick"]
    return json.dumps(keep)[:2000]


# --------------------------------------------------------------------------- #
# Consumer
# --------------------------------------------------------------------------- #

class ActionConsumer:
    """Polls the `action` table and applies each pending action exactly once."""

    def __init__(
        self,
        stdb: StdbHttp,
        dispatch: Dispatch,
        poll_seconds: float | None = None,
        on_branch: Callable[[int, dict], Awaitable[None]] | None = None,
        on_done: Callable[[dict, str], None] | None = None,
    ) -> None:
        self.stdb = stdb
        self.dispatch = dispatch
        self.poll_seconds = poll_seconds if poll_seconds is not None else float(os.getenv("STDB_POLL_SECONDS", "0.3"))
        self.on_branch = on_branch
        self.on_done = on_done  # (action row, final status) after the final ack
        self.processed: set[int] = set()
        self._processed_order: deque[int] = deque()
        self.has_lock = False
        self.applied = 0
        self.errors = 0
        self.conflicts = 0
        self.poll_failures = 0
        self.last_poll_ok: float | None = None
        self.last_error: str | None = None
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self.keep_finished = int(os.getenv("STDB_KEEP_ACTIONS", "200"))
        self._last_prune = 0.0

    def poke(self) -> None:
        """Poll now instead of waiting out the interval (e.g. from a tiny
        `POST /actions/poke` the browser fires after request_action resolves)."""
        self._wake.set()

    # -- lock ---------------------------------------------------------------- #

    async def claim(self) -> bool:
        try:
            status, text = await self.stdb.call("claim_engine", [])
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"claim: {type(exc).__name__}: {exc}"
            self.has_lock = False
            return False
        self.has_lock = status < 400
        if not self.has_lock:
            self.last_error = f"claim {status}: {text[:200]}"
        return self.has_lock

    async def _engine_call(self, reducer: str, args: list[Any]) -> None:
        code, text = await self.stdb.call(reducer, args)
        if code == 530 and "engine lock" in text:
            # Lost the lock (lease expired while we were stalled): re-claim once.
            if await self.claim():
                code, text = await self.stdb.call(reducer, args)
        if code >= 400:
            raise RuntimeError(f"{reducer} {code}: {text[:200]}")

    async def _ack(self, action_id: int, status: str, result: str) -> None:
        await self._engine_call("ack_action", [action_id, status, result])

    async def _final_ack(self, row: dict, status: str, result: str) -> None:
        try:
            await self._ack(int(row["id"]), status, result)
        except Exception as exc:  # noqa: BLE001 - row stays `running`; recovered on restart
            self.last_error = f"final ack: {type(exc).__name__}: {exc}"
            log.warning("final ack for action %s failed: %s", row["id"], self.last_error)
            return
        if self.on_done is not None:
            self.on_done(row, status)

    def _mark(self, action_id: int) -> None:
        self.processed.add(action_id)
        self._processed_order.append(action_id)
        while len(self._processed_order) > 5000:
            self.processed.discard(self._processed_order.popleft())

    # -- polling ------------------------------------------------------------- #

    async def recover_interrupted(self) -> int:
        """Actions left `running` by a previous engine are failed, not re-run."""
        rows = await self.stdb.sql("SELECT * FROM action WHERE status = 'running'")
        ids = [int(r["id"]) for r in rows]
        if ids:
            await self._engine_call("ack_actions", [ids, "error", "engine restarted while running this action"])
            for action_id in ids:
                self._mark(action_id)
        return len(ids)

    async def poll_once(self) -> list[int]:
        """One poll: claim the batch (one `running` ack), apply in id order,
        and pipeline the final acks so they never delay the next action."""
        rows = await self.stdb.sql("SELECT * FROM action WHERE status = 'pending'")
        self.last_poll_ok = time.time()
        batch = [r for r in sorted(rows, key=lambda r: int(r["id"])) if int(r["id"]) not in self.processed]
        if not batch:
            return []
        ids = [int(r["id"]) for r in batch]
        for action_id in ids:
            self._mark(action_id)  # before any await: never applied twice
        try:
            await self._engine_call("ack_actions", [ids, "running", ""])
        except Exception as exc:
            for action_id in ids:  # not claimed: let the next poll retry them
                self.processed.discard(action_id)
            if "claim conflict" in str(exc):
                self.conflicts += 1  # another engine process took (some of) them
                return []
            raise
        acks: list[asyncio.Task] = []
        for row in batch:
            try:
                payload = json.loads(row["payload"] or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("payload must be a JSON object")
                out = await self.dispatch(row["kind"], payload)
                if row["kind"] == "branch" and self.on_branch is not None:
                    await self.on_branch(int(row["id"]), out)
                self.applied += 1
                acks.append(asyncio.create_task(self._final_ack(row, "done", _short_result(out))))
            except Exception as exc:  # noqa: BLE001 - one bad action must not stop the queue
                self.errors += 1
                acks.append(asyncio.create_task(self._final_ack(row, "error", f"{type(exc).__name__}: {exc}"[:500])))
        await asyncio.gather(*acks)
        return ids

    async def run(self) -> None:
        backoff = self.poll_seconds
        while True:
            try:
                if not self.has_lock:
                    await self.stdb.start()  # mints the identity on first run
                    if not await self.claim():
                        raise RuntimeError(self.last_error or "claim_engine failed")
                    await self.recover_interrupted()
                await self.poll_once()
                if time.monotonic() - self._last_prune > 30:
                    # Bound the table every client subscribes to.
                    await self._engine_call("prune_actions", [self.keep_finished])
                    self._last_prune = time.monotonic()
                backoff = self.poll_seconds
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - SpacetimeDB down: keep the engine alive
                self.poll_failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"
                if self.poll_failures == 1 or self.poll_failures % 30 == 0:
                    log.warning("action poll failed (%d): %s", self.poll_failures, self.last_error)
                backoff = min(5.0, backoff * 2)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    def start(self) -> asyncio.Task:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run(), name="stdb-actions")
        return self._task

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self.has_lock:
            try:
                await self.stdb.call("release_engine", [])
            except Exception:  # noqa: BLE001
                pass

    def status(self) -> dict[str, Any]:
        return {
            "has_lock": self.has_lock,
            "applied": self.applied,
            "errors": self.errors,
            "conflicts": self.conflicts,
            "poll_failures": self.poll_failures,
            "last_poll_ok": self.last_poll_ok,
            "last_error": self.last_error,
        }
