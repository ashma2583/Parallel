"""
PARALLEL - SpacetimeDB publisher (Phase 2: State Sync).

SpacetimeDB has no maintained Python SDK, so the backend publishes via the
HTTP API: `POST /v1/database/{db}/call/{reducer}` with a JSON array of
reducer arguments (SATS-JSON: products as objects keyed by canonical
snake_case field name).

The reducer lives in `spacetimedb/src/index.ts`. Its signature is:

    publish_state(tick: u64, nodes: Node[], edges: Edge[], summary: TickSummary)

Configuration (environment variables, all optional):
    STDB_ENABLED   "1" (default) or "0" to run the engine without SpacetimeDB
    STDB_URL       default "http://127.0.0.1:3000"
    STDB_DATABASE  default "parallel"
    STDB_TIMEOUT   seconds per publish request, default "0.5" (the action poller keeps 2)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from graph import CampusGraph

log = logging.getLogger("parallel.stdb")

_LOG_EVERY_N_FAILURES = 30  # avoid spamming the console when STDB is down


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


class SpacetimePublisher:
    def __init__(
        self,
        base_url: str | None = None,
        database: str | None = None,
        enabled: bool | None = None,
        timeout: float | None = None,
    ) -> None:
        self.base_url = (base_url or os.getenv("STDB_URL", "http://127.0.0.1:3000")).rstrip("/")
        self.database = database or os.getenv("STDB_DATABASE", "parallel")
        self.enabled = _env_bool("STDB_ENABLED", True) if enabled is None else enabled
        # Publishing runs in a background worker, so this only bounds how long one snapshot
        # can hang. The sim loop and the routes never wait on it.
        self.timeout = timeout if timeout is not None else float(os.getenv("STDB_TIMEOUT", "0.5"))

        self._client: httpx.AsyncClient | None = None
        self._identity: Any = None  # stdb_actions.StdbHttp, created lazily
        self._claimed = False
        # Fire-and-forget queue: the sim loop and the REST routes only drop the
        # newest snapshot here; one background worker talks to SpacetimeDB.
        self._latest: list[Any] | None = None
        self._clear_pending = False
        self._worker: asyncio.Task | None = None
        self.publishes = 0
        self.failures = 0
        self.consecutive_failures = 0
        self.last_ok_at: float | None = None
        self.last_error: str | None = None

    # -- lifecycle ----------------------------------------------------------- #

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)

    # -- engine identity (Phase 5) ------------------------------------------- #
    # publish_state / clear_state are engine-only (`ensureEngine` in the module).
    # The engine uses one persistent identity (token file shared with
    # stdb_actions.StdbHttp) and holds the lock via `claim_engine`.

    def identity_client(self) -> Any:
        """The engine's one SpacetimeDB identity. The action consumer shares it,
        so the publisher and the consumer can never fight over the engine lock."""
        if self._identity is None:
            from stdb_actions import StdbHttp  # local import: no cycle at module load

            self._identity = StdbHttp(self.base_url, self.database)  # default 2 s: SQL polls can be slower than a publish
        return self._identity

    async def _ensure_auth(self) -> None:
        self.identity_client()
        if self._identity.token is None:
            await self._identity.start()  # loads or mints the token (raises if STDB is down)
        if not self._claimed:
            assert self._client is not None
            resp = await self._client.post(self._reducer_url("claim_engine"), json=[], headers=self._auth_headers())
            if resp.status_code >= 400:
                raise RuntimeError(f"claim_engine {resp.status_code} {resp.text[:200]}")
            self._claimed = True

    def _auth_headers(self) -> dict[str, str]:
        token = self._identity.token if self._identity is not None else None
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def close(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._identity is not None:
            await self._identity.close()

    # -- publishing ---------------------------------------------------------- #

    def _reducer_url(self, reducer: str) -> str:
        return f"/v1/database/{self.database}/call/{reducer}"

    async def call(self, reducer: str, args: list[Any]) -> bool:
        """Invoke a reducer. Returns True on success; never raises."""
        if not self.enabled:
            return False
        if self._client is None:
            await self.start()
        assert self._client is not None

        try:
            await self._ensure_auth()
            resp = await self._client.post(self._reducer_url(reducer), json=args, headers=self._auth_headers())
            if resp.status_code == 530 and "engine lock" in resp.text:
                # Phase 5: engine-only reducers need the engine lock. Take it and retry once.
                self._claimed = False
                await self._ensure_auth()
                resp = await self._client.post(self._reducer_url(reducer), json=args, headers=self._auth_headers())
            if resp.status_code >= 400:
                raise RuntimeError(f"{resp.status_code} {resp.text[:300]}")
        except Exception as exc:  # noqa: BLE001 - publishing must never kill the sim
            self.failures += 1
            self.consecutive_failures += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
            if self.consecutive_failures == 1 or self.consecutive_failures % _LOG_EVERY_N_FAILURES == 0:
                log.warning(
                    "SpacetimeDB publish failed (%d in a row) -> %s %s: %s",
                    self.consecutive_failures, self.base_url, self._reducer_url(reducer), self.last_error,
                )
            return False

        if self.consecutive_failures:
            log.info("SpacetimeDB publish recovered after %d failures", self.consecutive_failures)
        self.consecutive_failures = 0
        self.publishes += 1
        self.last_ok_at = time.time()
        return True

    def _kick(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._drain(), name="stdb-publish")

    async def _drain(self) -> None:
        """Send the newest snapshot (and any pending clear first). Latest wins,
        so a slow or hung SpacetimeDB never builds a backlog."""
        while self._clear_pending or self._latest is not None:
            if self._clear_pending:
                self._clear_pending = False
                await self.call("clear_state", [])
            args, self._latest = self._latest, None
            if args is not None:
                await self.call("publish_state", args)
            if self.consecutive_failures:
                await asyncio.sleep(0.5)  # SpacetimeDB is down: do not spin

    async def publish(self, graph: CampusGraph) -> bool:
        """Queue the current graph snapshot for `publish_state`. Never waits on
        SpacetimeDB. Returns whether publishing is enabled."""
        if not self.enabled:
            return False
        self._latest = build_publish_args(graph)
        self._kick()
        return True

    async def clear(self) -> bool:
        if not self.enabled:
            return False
        self._clear_pending = True
        self._latest = None  # anything older than the clear is stale
        self._kick()
        return True

    # -- introspection ------------------------------------------------------- #

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "url": self.base_url,
            "database": self.database,
            "connected": self.enabled and self.consecutive_failures == 0 and self.publishes > 0,
            "publishes": self.publishes,
            "failures": self.failures,
            "consecutive_failures": self.consecutive_failures,
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
        }


# --------------------------------------------------------------------------- #
# Serialization: Python engine dicts -> SpacetimeDB row shapes
#
# SpacetimeDB canonicalizes the module's camelCase column names to snake_case
# (e.g. `currentPower` -> `current_power`), and the HTTP API expects the
# canonical names. Those match the Python engine's field names 1:1.
# --------------------------------------------------------------------------- #

def node_row(n: dict[str, Any]) -> dict[str, Any]:
    pos = n.get("position") or {}
    return {
        "id": n["id"],
        "name": n["name"],
        "type": n["type"],
        "priority": n["priority"],
        "capacity": float(n["capacity"]),
        "demand": float(n["demand"]),
        "current_power": float(n["current_power"]),
        "occupancy": int(n["occupancy"]),
        "status": n["status"],
        "failed": bool(n["failed"]),
        "load_shed": float(n["load_shed"]),
        "power_ratio": float(n["power_ratio"]),
        "x": float(pos.get("x", 0.0)),
        "y": float(pos.get("y", 0.0)),
    }


def edge_row(e: dict[str, Any]) -> dict[str, Any]:
    return {"id": e["id"], "source": e["source"], "target": e["target"], "type": e["type"]}


def summary_row(s: dict[str, Any]) -> dict[str, Any]:
    counts = s.get("status_counts") or {}
    return {
        "supply": float(s["supply"]),
        "demand": float(s["demand"]),
        "deficit": float(s["deficit"]),
        "power_ratio": float(s["power_ratio"]),
        "green": int(counts.get("Green", 0)),
        "amber": int(counts.get("Amber", 0)),
        "red": int(counts.get("Red", 0)),
    }


def build_publish_args(graph: CampusGraph) -> list[Any]:
    """Positional reducer args for `publish_state`, in declaration order."""
    snap = graph.to_dict()
    summary = snap["summary"] or {}
    return [
        int(snap["tick"]),
        [node_row(n) for n in snap["nodes"]],
        [edge_row(e) for e in snap["edges"]],
        summary_row(summary),
    ]
