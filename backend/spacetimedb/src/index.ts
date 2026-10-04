/**
 * PARALLEL - SpacetimeDB module entry.
 *
 * Phase 2: the Python FastAPI backend is the simulation authority. Once per
 * tick it calls `publish_state` over SpacetimeDB's HTTP API; this reducer
 * upserts the rows and SpacetimeDB fans the diff out to every subscriber.
 *
 * Phase 5: multiplayer. Browsers call `join` / `move_cursor` / `request_action`
 * / `plan_*` over the WebSocket SDK. The engine (Python, HTTP + bearer token)
 * claims the engine lock with `claim_engine`, polls `action` with SQL, and
 * acks with `ack_action`. Every engine-only reducer starts with
 * `ensureEngine(ctx)`.
 */

import { SenderError, t, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb, { node, edge, campus, TickSummary } from './schema';

export { default } from './schema';

const SIM_STATE_ID = 0;
const SINGLETON = 0;

/** An engine that has not called an engine-only reducer for this long can be replaced. */
const ENGINE_LEASE_MICROS = 15_000_000n;
/** Only rewrite `engine.last_seen` when it is older than this (fewer broadcasts). */
const ENGINE_TOUCH_MICROS = 1_000_000n;

const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PAYLOAD = 8192;
const MAX_KEY = 64;
const ACTION_STATUSES = new Set(['pending', 'running', 'done', 'error']);
const KEEP_BRANCH_RESULTS = 5;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type NodeRow = Infer<typeof node.rowType>;

function micros(ts: { microsSinceUnixEpoch: bigint }): bigint {
  return ts.microsSinceUnixEpoch;
}

function connHex(ctx: Ctx): string {
  return ctx.connectionId ? ctx.connectionId.toHexString() : '';
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// --------------------------------------------------------------------------- //
// Engine lock
// --------------------------------------------------------------------------- //

function isOwner(ctx: Ctx): boolean {
  const row = ctx.db.moduleOwner.id.find(SINGLETON);
  return !!row && row.owner.isEqual(ctx.sender);
}

/**
 * Throw unless the caller is the engine that holds the lock. Refreshes the
 * lease (at most once per second) so a live engine is never displaced.
 */
function ensureEngine(ctx: Ctx): void {
  const row = ctx.db.engine.id.find(SINGLETON);
  if (!row || !row.hasEngine || !row.engine.isEqual(ctx.sender)) {
    throw new SenderError('engine-only reducer: caller does not hold the engine lock (call claim_engine)');
  }
  if (micros(ctx.timestamp) - micros(row.lastSeen) > ENGINE_TOUCH_MICROS) {
    ctx.db.engine.id.update({ ...row, lastSeen: ctx.timestamp });
  }
}

export const init = spacetimedb.init(ctx => {
  ctx.db.moduleOwner.insert({ id: SINGLETON, owner: ctx.sender });
  ctx.db.engine.insert({
    id: SINGLETON,
    engine: ctx.sender,
    hasEngine: false,
    claimedAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
  });
});

/**
 * Take the engine lock. Succeeds when nobody holds it, when the caller already
 * holds it (refresh), when the holder's lease expired (engine restarted with a
 * new identity), or when the caller is the database owner.
 */
export const claim_engine = spacetimedb.reducer(ctx => {
  const row = ctx.db.engine.id.find(SINGLETON);
  const fresh = {
    id: SINGLETON,
    engine: ctx.sender,
    hasEngine: true,
    claimedAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
  };
  if (!row) {
    ctx.db.engine.insert(fresh);
    return;
  }
  if (row.hasEngine && row.engine.isEqual(ctx.sender)) {
    ctx.db.engine.id.update({ ...row, lastSeen: ctx.timestamp });
    return;
  }
  const expired = micros(ctx.timestamp) - micros(row.lastSeen) > ENGINE_LEASE_MICROS;
  if (!row.hasEngine || expired || isOwner(ctx)) {
    if (row.hasEngine) console.info(`engine lock taken over from ${row.engine.toHexString()}`);
    ctx.db.engine.id.update(fresh);
    return;
  }
  throw new SenderError('engine lock is held by a live engine');
});

/** Give the lock back (engine shutting down, or the owner forcing a re-claim). */
export const release_engine = spacetimedb.reducer(ctx => {
  const row = ctx.db.engine.id.find(SINGLETON);
  if (!row || !row.hasEngine) return;
  if (!row.engine.isEqual(ctx.sender) && !isOwner(ctx)) {
    throw new SenderError('only the engine or the owner can release the lock');
  }
  ctx.db.engine.id.update({ ...row, hasEngine: false, lastSeen: ctx.timestamp });
});

/** Cheap liveness ping for cycles in which the engine wrote nothing else. */
export const engine_heartbeat = spacetimedb.reducer(ctx => {
  ensureEngine(ctx);
});

// --------------------------------------------------------------------------- //
// Phase 2: simulation mirror
// --------------------------------------------------------------------------- //

/** True when every column except the primary key is identical. */
function sameNode(a: NodeRow, b: NodeRow): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    a.priority === b.priority &&
    a.capacity === b.capacity &&
    a.demand === b.demand &&
    a.currentPower === b.currentPower &&
    a.occupancy === b.occupancy &&
    a.status === b.status &&
    a.failed === b.failed &&
    a.loadShed === b.loadShed &&
    a.powerRatio === b.powerRatio &&
    a.x === b.x &&
    a.y === b.y
  );
}

/**
 * Replace the published simulation snapshot.
 *
 * - Nodes are upserted by id; unchanged rows are skipped so subscribers only
 *   receive events for nodes that actually changed this tick.
 * - Edges are static; they are inserted once and never updated.
 * - sim_state (singleton) is always updated so clients see the tick advance.
 */
export const publish_state = spacetimedb.reducer(
  {
    tick: t.u64(),
    nodes: t.array(node.rowType),
    edges: t.array(edge.rowType),
    summary: TickSummary,
  },
  (ctx, { tick, nodes, edges, summary }) => {
    ensureEngine(ctx);
    for (const n of nodes) {
      const existing = ctx.db.node.id.find(n.id);
      if (!existing) {
        ctx.db.node.insert(n);
      } else if (!sameNode(existing, n)) {
        ctx.db.node.id.update(n);
      }
    }

    for (const e of edges) {
      if (!ctx.db.edge.id.find(e.id)) {
        ctx.db.edge.insert(e);
      }
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const existing of [...ctx.db.node.iter()]) {
      if (!nodeIds.has(existing.id)) ctx.db.node.id.delete(existing.id);
    }
    const edgeIds = new Set(edges.map((e) => e.id));
    for (const existing of [...ctx.db.edge.iter()]) {
      if (!edgeIds.has(existing.id)) ctx.db.edge.id.delete(existing.id);
    }

    const row = {
      id: SIM_STATE_ID,
      tick,
      supply: summary.supply,
      demand: summary.demand,
      deficit: summary.deficit,
      powerRatio: summary.powerRatio,
      green: summary.green,
      amber: summary.amber,
      red: summary.red,
      updatedAt: ctx.timestamp,
    };
    if (ctx.db.simState.id.find(SIM_STATE_ID)) {
      ctx.db.simState.id.update(row);
    } else {
      ctx.db.simState.insert(row);
    }
  }
);

/** Wipe all published rows (used when the engine is reset). */
export const clear_state = spacetimedb.reducer(ctx => {
  ensureEngine(ctx);
  for (const n of [...ctx.db.node.iter()]) ctx.db.node.id.delete(n.id);
  for (const e of [...ctx.db.edge.iter()]) ctx.db.edge.id.delete(e.id);
  ctx.db.simState.id.delete(SIM_STATE_ID);
});

// --------------------------------------------------------------------------- //
// Phase 5 L1: presence
// --------------------------------------------------------------------------- //

export const join = spacetimedb.reducer(
  { name: t.string(), role: t.string() },
  (ctx, { name, role }) => {
    const clean = clip(name.trim(), 32) || 'Director';
    const cleanRole = clip(role.trim().toLowerCase(), 16);
    const existing = ctx.db.presence.identity.find(ctx.sender);
    if (existing) {
      ctx.db.presence.identity.update({
        ...existing,
        conn: connHex(ctx),
        name: clean,
        role: cleanRole,
        lastSeen: ctx.timestamp,
      });
    } else {
      ctx.db.presence.insert({
        identity: ctx.sender,
        conn: connHex(ctx),
        name: clean,
        role: cleanRole,
        hasCursor: false,
        cursorLng: 0,
        cursorLat: 0,
        joinedAt: ctx.timestamp,
        lastSeen: ctx.timestamp,
      });
    }
  }
);

export const heartbeat = spacetimedb.reducer(ctx => {
  const row = ctx.db.presence.identity.find(ctx.sender);
  if (row) ctx.db.presence.identity.update({ ...row, lastSeen: ctx.timestamp });
});

export const move_cursor = spacetimedb.reducer(
  { lng: t.f64(), lat: t.f64() },
  (ctx, { lng, lat }) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      throw new SenderError('cursor out of range');
    }
    const row = ctx.db.presence.identity.find(ctx.sender);
    if (!row) return; // not joined: ignore silently
    ctx.db.presence.identity.update({
      ...row,
      hasCursor: true,
      cursorLng: lng,
      cursorLat: lat,
      lastSeen: ctx.timestamp,
    });
  }
);

export const leave = spacetimedb.reducer(ctx => {
  ctx.db.presence.identity.delete(ctx.sender);
});

/** Engine-only: drop presence rows not refreshed for `maxIdleSecs` (crash leftovers). */
export const sweep_presence = spacetimedb.reducer(
  { maxIdleSecs: t.u32() },
  (ctx, { maxIdleSecs }) => {
    ensureEngine(ctx);
    const cutoff = micros(ctx.timestamp) - BigInt(maxIdleSecs) * 1_000_000n;
    for (const row of [...ctx.db.presence.iter()]) {
      if (micros(row.lastSeen) < cutoff) ctx.db.presence.identity.delete(row.identity);
    }
  }
);

export const on_disconnect = spacetimedb.clientDisconnected(ctx => {
  const row = ctx.db.presence.identity.find(ctx.sender);
  // Only the connection that joined removes the row, so a second tab sharing
  // the identity does not wipe the first tab's presence.
  if (row && (row.conn === '' || row.conn === connHex(ctx))) {
    ctx.db.presence.identity.delete(ctx.sender);
  }
});

// --------------------------------------------------------------------------- //
// Phase 5 L2: action queue
// --------------------------------------------------------------------------- //

/**
 * Any client: enqueue a command for the engine. Idempotent on `clientKey`, so
 * a retried call never creates a second action.
 */
export const request_action = spacetimedb.reducer(
  { kind: t.string(), payload: t.string(), clientKey: t.string() },
  (ctx, { kind, payload, clientKey }) => {
    if (!KIND_RE.test(kind)) throw new SenderError(`bad action kind: ${clip(kind, 40)}`);
    if (payload.length > MAX_PAYLOAD) throw new SenderError('payload too large');
    if (clientKey.length === 0 || clientKey.length > MAX_KEY) throw new SenderError('bad clientKey');
    if (ctx.db.action.clientKey.find(clientKey)) return; // duplicate submit
    const who = ctx.db.presence.identity.find(ctx.sender);
    ctx.db.action.insert({
      id: 0n,
      clientKey,
      kind,
      payload,
      sender: ctx.sender,
      senderName: who ? who.name : '',
      status: 'pending',
      result: '',
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

/** Engine-only: move an action to running / done / error. */
export const ack_action = spacetimedb.reducer(
  { id: t.u64(), status: t.string(), result: t.string() },
  (ctx, { id, status, result }) => {
    ensureEngine(ctx);
    if (!ACTION_STATUSES.has(status)) throw new SenderError(`bad status: ${clip(status, 20)}`);
    const row = ctx.db.action.id.find(id);
    if (!row) return;
    ctx.db.action.id.update({ ...row, status, result: clip(result, MAX_PAYLOAD), updatedAt: ctx.timestamp });
  }
);

/**
 * Engine-only: same as ack_action for a whole poll batch in one round trip.
 * Moving to `running` is a compare-and-set: if ANY row is no longer `pending`
 * the whole call fails (transaction rolls back), so two engine processes that
 * share an identity can never both take the same action.
 */
export const ack_actions = spacetimedb.reducer(
  { ids: t.array(t.u64()), status: t.string(), result: t.string() },
  (ctx, { ids, status, result }) => {
    ensureEngine(ctx);
    if (!ACTION_STATUSES.has(status)) throw new SenderError(`bad status: ${clip(status, 20)}`);
    if (status === 'running') {
      for (const id of ids) {
        const row = ctx.db.action.id.find(id);
        if (!row || row.status !== 'pending') throw new SenderError(`claim conflict: action ${id} is not pending`);
      }
    }
    for (const id of ids) {
      const row = ctx.db.action.id.find(id);
      if (row) ctx.db.action.id.update({ ...row, status, result: clip(result, MAX_PAYLOAD), updatedAt: ctx.timestamp });
    }
  }
);

/** Engine-only: keep only the newest `keep` finished actions. */
export const prune_actions = spacetimedb.reducer(
  { keep: t.u32() },
  (ctx, { keep }) => {
    ensureEngine(ctx);
    const finished = [...ctx.db.action.iter()]
      .filter(a => a.status === 'done' || a.status === 'error')
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const a of finished.slice(keep)) ctx.db.action.id.delete(a.id);
  }
);

// --------------------------------------------------------------------------- //
// Phase 5 L3: shared Branch results, scenario plan, campus catalog
// --------------------------------------------------------------------------- //

export const publish_branch_result = spacetimedb.reducer(
  { actionId: t.u64(), label: t.string(), payload: t.string() },
  (ctx, { actionId, label, payload }) => {
    ensureEngine(ctx);
    ctx.db.branchResult.insert({
      id: 0n,
      actionId,
      label: clip(label, 120),
      payload: clip(payload, 64_000),
      createdAt: ctx.timestamp,
    });
    const rows = [...ctx.db.branchResult.iter()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const r of rows.slice(KEEP_BRANCH_RESULTS)) ctx.db.branchResult.id.delete(r.id);
  }
);

export const plan_upsert = spacetimedb.reducer(
  { itemKey: t.string(), kind: t.string(), payload: t.string(), position: t.u32() },
  (ctx, { itemKey, kind, payload, position }) => {
    if (itemKey.length === 0 || itemKey.length > MAX_KEY) throw new SenderError('bad itemKey');
    if (!KIND_RE.test(kind)) throw new SenderError('bad plan kind');
    if (payload.length > MAX_PAYLOAD) throw new SenderError('payload too large');
    const who = ctx.db.presence.identity.find(ctx.sender);
    const existing = ctx.db.scenarioPlan.itemKey.find(itemKey);
    const row = {
      itemKey,
      kind,
      payload,
      position,
      version: existing ? existing.version + 1 : 1,
      updatedBy: ctx.sender,
      updatedByName: who ? who.name : '',
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.scenarioPlan.itemKey.update(row);
    else ctx.db.scenarioPlan.insert(row);
  }
);

export const plan_remove = spacetimedb.reducer(
  { itemKey: t.string() },
  (ctx, { itemKey }) => {
    ctx.db.scenarioPlan.itemKey.delete(itemKey);
  }
);

export const plan_clear = spacetimedb.reducer(ctx => {
  for (const r of [...ctx.db.scenarioPlan.iter()]) ctx.db.scenarioPlan.itemKey.delete(r.itemKey);
});

/** Engine-only: upsert the campus catalog; `replace` deletes ids not in `rows`. */
export const upsert_campuses = spacetimedb.reducer(
  { rows: t.array(campus.rowType), replace: t.bool() },
  (ctx, { rows, replace }) => {
    ensureEngine(ctx);
    for (const c of rows) {
      if (ctx.db.campus.id.find(c.id)) ctx.db.campus.id.update(c);
      else ctx.db.campus.insert(c);
    }
    if (replace) {
      const keep = new Set(rows.map(c => c.id));
      for (const c of [...ctx.db.campus.iter()]) if (!keep.has(c.id)) ctx.db.campus.id.delete(c.id);
    }
  }
);

export const publish_survey = spacetimedb.reducer(
  { campusId: t.string(), status: t.string(), payload: t.string() },
  (ctx, { campusId, status, payload }) => {
    ensureEngine(ctx);
    const row = { campusId, status: clip(status, 16), payload: clip(payload, 64_000), updatedAt: ctx.timestamp };
    if (ctx.db.campusSurvey.campusId.find(campusId)) ctx.db.campusSurvey.campusId.update(row);
    else ctx.db.campusSurvey.insert(row);
  }
);
