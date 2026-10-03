/**
 * PARALLEL - SpacetimeDB module entry (Phase 2: State Sync).
 *
 * The Python FastAPI backend is the simulation authority. Once per tick it
 * calls `publish_state` over SpacetimeDB's HTTP API; this reducer upserts the
 * rows and SpacetimeDB fans the diff out to every subscribed client.
 */

import { t, type Infer } from 'spacetimedb/server';
import spacetimedb, { node, edge, TickSummary } from './schema';

export { default } from './schema';

const SIM_STATE_ID = 0;

type NodeRow = Infer<typeof node.rowType>;

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
  for (const n of [...ctx.db.node.iter()]) ctx.db.node.id.delete(n.id);
  for (const e of [...ctx.db.edge.iter()]) ctx.db.edge.id.delete(e.id);
  ctx.db.simState.id.delete(SIM_STATE_ID);
});
