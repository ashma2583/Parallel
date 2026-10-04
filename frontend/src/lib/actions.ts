/**
 * Prototype of frontend/src/lib/actions.ts: the ONE function UI code calls.
 *
 * - SpacetimeDB live  -> `request_action` reducer (the engine applies it and
 *   every window sees the action row move pending -> running -> done).
 * - otherwise         -> the same command over REST.
 *
 * Every send carries a clientKey. It is the `request_action` idempotency key
 * and is also sent to REST as `X-Action-Key`, so the engine applies a command
 * at most once even if a reducer call that timed out did reach SpacetimeDB and
 * the UI then retried over REST.
 */
import type { DbConnection } from '../module_bindings';
import { BACKEND_URL } from '../config';

export type SendResult = {
  via: 'stdb' | 'rest' | 'rest-after-stdb-timeout';
  clientKey: string;
  ok: boolean;
  ms: number;
  error?: string;
  restStatus?: number;
};

/** kind -> REST route; mirrors backend/stdb_actions.py KIND_ROUTES. */
export const KIND_REST: Record<string, { path: string; shape?: (p: Record<string, unknown>) => unknown }> = {
  disrupt: { path: '/disrupt' },
  fail_node: { path: '/disrupt', shape: p => ({ ...p, action: 'fail' }) },
  restore_node: { path: '/disrupt', shape: p => ({ ...p, action: 'restore' }) },
  reset: { path: '/reset' },
  tick: { path: '/tick' },
  strategy: { path: '/strategy' },
  priority: { path: '/priority' },
  hazard: { path: '/hazards/apply' },
  weather: { path: '/weather/apply' },
  branch: { path: '/branch' },
  storm_start: { path: '/storms/start' },
  storm_hit: { path: '/storms/hit' },
  storm_end: { path: '/storms/end' },
  suspend_line: { path: '/storms/routes/suspend' },
  restore_line: { path: '/storms/routes/restore' },
  scenario_run: { path: '/storms/scenario/run' },
  scenario_clear: { path: '/storms/scenario/clear' },
};

/**
 * Where this window stands. Root.tsx sets the connection, useSim sets whether
 * the engine says it is consuming actions. Both must hold for the reducer path.
 */
const link: { conn: DbConnection | null; connected: boolean; engineAt: number } = {
  conn: null,
  connected: false,
  engineAt: 0,
};
const ENGINE_FRESH_MS = 6000;

export function setStdbConnection(conn: DbConnection | null, connected: boolean): void {
  link.conn = conn;
  link.connected = connected;
}

/** The engine's /activity reply said `actions_live` (it holds the lock and is polling). */
export function noteEngineActions(live: boolean): void {
  link.engineAt = live ? Date.now() : 0;
}

/** True when this window is connected and the engine is demonstrably consuming actions. */
export function reducerLive(): boolean {
  return link.connected && link.conn !== null && Date.now() - link.engineAt < ENGINE_FRESH_MS;
}

/** Rows the engine has finished with, by clientKey, and callers waiting for one. */
type Outcome = { status: string; result: string };
const finished = new Map<string, Outcome>();
const waiting = new Map<string, (o: Outcome) => void>();
const APPLY_TIMEOUT_MS = 10000;

function noteRow(row: { clientKey: string; status: string; result: string }): void {
  if (row.status !== 'done' && row.status !== 'error') return;
  const outcome = { status: row.status, result: row.result };
  const waiter = waiting.get(row.clientKey);
  if (waiter) {
    waiting.delete(row.clientKey);
    waiter(outcome);
    return;
  }
  finished.set(row.clientKey, outcome);
  if (finished.size > 500) finished.delete(finished.keys().next().value as string);
}

/** Root.tsx calls this once per connection: follow the action rows so sends can wait for the engine. */
export function watchActions(conn: DbConnection): void {
  conn.db.action.onInsert((_ctx, row) => noteRow(row));
  conn.db.action.onUpdate((_ctx, _old, row) => noteRow(row));
  conn.subscriptionBuilder().subscribe(['SELECT * FROM action']);
}

function applied(clientKey: string): Promise<Outcome> {
  const hit = finished.get(clientKey);
  if (hit) {
    finished.delete(clientKey);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(clientKey);
      reject(new Error(`the engine did not apply the action within ${APPLY_TIMEOUT_MS / 1000} s`));
    }, APPLY_TIMEOUT_MS);
    waiting.set(clientKey, (o) => {
      clearTimeout(timer);
      resolve(o);
    });
  });
}

/**
 * Reducer when `reducerLive()`; REST otherwise. Like a REST call, it resolves once
 * the engine has applied the action, so callers can read the result right after.
 */
export async function sendDefault(kind: string, payload: Record<string, unknown>): Promise<SendResult> {
  const res = await sendAction({ live: reducerLive(), conn: link.conn, restBase: BACKEND_URL }, kind, payload);
  if (res.via !== 'stdb' || !res.ok) return res;
  try {
    const out = await applied(res.clientKey);
    return out.status === 'done' ? res : { ...res, ok: false, error: out.result };
  } catch (e) {
    return { ...res, ok: false, error: String(e) };
  }
}

const REDUCER_TIMEOUT_MS = 1500;
const REST_TIMEOUT_MS = 8000;

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function viaRest(restBase: string, kind: string, payload: Record<string, unknown>, clientKey: string) {
  const route = KIND_REST[kind];
  if (!route) throw new Error(`unknown action kind ${kind}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(`${restBase}${route.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Action-Key': clientKey },
      body: JSON.stringify(route.shape ? route.shape(payload) : payload),
      signal: ctrl.signal,
    });
    return res.status;
  } finally {
    clearTimeout(t);
  }
}

export async function sendAction(
  ctx: { live: boolean; conn: DbConnection | null; restBase: string },
  kind: string,
  payload: Record<string, unknown>,
): Promise<SendResult> {
  const clientKey = newKey();
  const t0 = performance.now();
  let via: SendResult['via'] = 'rest';
  if (ctx.live && ctx.conn) {
    try {
      await withTimeout(
        ctx.conn.reducers.requestAction({ kind, payload: JSON.stringify(payload), clientKey }),
        REDUCER_TIMEOUT_MS,
      );
      // Ask the engine to poll now. Best effort: the poll would find the row anyway.
      fetch(`${ctx.restBase}/actions/poke`, { method: 'POST', keepalive: true }).catch(() => undefined);
      return { via: 'stdb', clientKey, ok: true, ms: performance.now() - t0 };
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('timeout')) {
        // The module rejected it (bad kind, too large): REST would not do better.
        return { via: 'stdb', clientKey, ok: false, ms: performance.now() - t0, error: msg };
      }
      via = 'rest-after-stdb-timeout'; // connection stalled: same clientKey over REST
    }
  }
  try {
    const status = await viaRest(ctx.restBase, kind, payload, clientKey);
    return { via, clientKey, ok: status < 400, ms: performance.now() - t0, restStatus: status };
  } catch (e) {
    return { via, clientKey, ok: false, ms: performance.now() - t0, error: String(e) };
  }
}
