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
