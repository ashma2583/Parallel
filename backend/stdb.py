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
    STDB_TIMEOUT   seconds per request, default "2"
"""

from __future__ import annotations

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
        self.timeout = timeout if timeout is not None else float(os.getenv("STDB_TIMEOUT", "2"))

        self._client: httpx.AsyncClient | None = None
        self.publishes = 0
        self.failures = 0
        self.consecutive_failures = 0
        self.last_ok_at: float | None = None
        self.last_error: str | None = None

    # -- lifecycle ----------------------------------------------------------- #

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

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
            resp = await self._client.post(self._reducer_url(reducer), json=args)
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

    async def publish(self, graph: CampusGraph) -> bool:
        """Push the current graph snapshot to the `publish_state` reducer."""
        return await self.call("publish_state", build_publish_args(graph))

    async def clear(self) -> bool:
        return await self.call("clear_state", [])

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
