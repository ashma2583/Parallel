/**
 * PARALLEL - SpacetimeDB schema (Phase 2: State Sync).
 *
 * Three public tables mirror the Python simulation engine's state so that any
 * client (the React map in Phase 3) can subscribe and receive row-level
 * updates the instant the backend publishes a new tick.
 *
 *   node      - one row per campus node (15 rows), keyed by string id
 *   edge      - power lines + roads (static), keyed by string id
 *   sim_state - singleton row (id = 0) with the latest tick summary
 *
 * Columns are declared camelCase (TS convention) but SpacetimeDB stores them
 * under canonical snake_case names (`currentPower` -> `current_power`). SQL
 * queries and the HTTP reducer API use the snake_case names, which match the
 * Python engine's fields 1:1. Generated TS client bindings expose camelCase.
 */

import { schema, table, t } from 'spacetimedb/server';

export const node = table(
  { name: 'node', public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    type: t.string(),         // substation | hospital | dorm | dining | library | transit
    priority: t.string(),     // critical | high | medium | low | none
    capacity: t.f64(),        // kW a substation can supply (0 for consumers)
    demand: t.f64(),          // kW a consumer wants (0 for substations)
    currentPower: t.f64(),    // kW delivered this tick
    occupancy: t.u32(),       // people at the node
    status: t.string(),       // Green | Amber | Red
    failed: t.bool(),
    loadShed: t.f64(),        // 0..1 fraction of demand intentionally cut
    powerRatio: t.f64(),      // currentPower / nominal
    x: t.f64(),               // layout hint for the map
    y: t.f64(),
  }
);

export const edge = table(
  { name: 'edge', public: true },
  {
    id: t.string().primaryKey(),
    source: t.string(),
    target: t.string(),
    type: t.string(),         // power | road
  }
);

export const simState = table(
  { name: 'sim_state', public: true },
  {
    id: t.u32().primaryKey(), // always 0 - singleton row
    tick: t.u64(),
    supply: t.f64(),
    demand: t.f64(),
    deficit: t.f64(),
    powerRatio: t.f64(),
    green: t.u32(),
    amber: t.u32(),
    red: t.u32(),
    updatedAt: t.timestamp(),
  }
);

/** Shape of the per-tick summary the Python engine sends alongside nodes. */
export const TickSummary = t.object('TickSummary', {
  supply: t.f64(),
  demand: t.f64(),
  deficit: t.f64(),
  powerRatio: t.f64(),
  green: t.u32(),
  amber: t.u32(),
  red: t.u32(),
});

const spacetimedb = schema({ node, edge, simState });
export default spacetimedb;
