/**
 * PARALLEL - SpacetimeDB schema.
 *
 * Phase 2 (state sync): `node`, `edge`, `sim_state` mirror the Python engine.
 * Phase 5 (multiplayer):
 *   presence       - one row per connected director (cursor, name, role)
 *   action         - browser -> engine command queue (request_action / ack_action)
 *   branch_result  - last Branch runs, shared by every director
 *   scenario_plan  - co-edited Scenario dock plan, one row per plan item
 *   campus         - campus catalog (U-M twin + researched + illustrative)
 *   campus_survey  - research results for a campus, shared by every director
 *   engine         - engine lock: which identity may call engine-only reducers
 *   module_owner   - private: identity that first published the database
 *
 * Columns are declared camelCase (TS convention) but SpacetimeDB stores them
 * under canonical snake_case names (`currentPower` -> `current_power`). SQL
 * queries and the HTTP reducer API use the snake_case names, which match the
 * Python engine's fields 1:1. Generated TS client bindings expose camelCase.
 */

import { schema, table, t } from 'spacetimedb/server';

// --------------------------------------------------------------------------- //
// Phase 2: simulation mirror (engine-only writes)
// --------------------------------------------------------------------------- //

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

// --------------------------------------------------------------------------- //
// Phase 5 L1: presence
// --------------------------------------------------------------------------- //

export const presence = table(
  { name: 'presence', public: true },
  {
    identity: t.identity().primaryKey(),
    conn: t.string(),         // hex connection id that last called join ('' over HTTP)
    name: t.string(),
    role: t.string(),         // '' | energy | transit | observer ...
    hasCursor: t.bool(),
    cursorLng: t.f64(),
    cursorLat: t.f64(),
    joinedAt: t.timestamp(),
    lastSeen: t.timestamp(),  // join / heartbeat / move_cursor
  }
);

// --------------------------------------------------------------------------- //
// Phase 5 L2: action queue (browser -> engine)
// --------------------------------------------------------------------------- //

export const action = table(
  { name: 'action', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    clientKey: t.string().unique(),  // client-generated id: idempotency + correlation
    kind: t.string(),                // fail_node | restore_node | hazard | scenario_run | ...
    payload: t.string(),             // JSON
    sender: t.identity(),
    senderName: t.string(),
    status: t.string().index('btree'), // pending | running | done | error
    result: t.string(),              // short JSON / error text written by the engine
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// --------------------------------------------------------------------------- //
// Phase 5 L3: shared state
// --------------------------------------------------------------------------- //

export const branchResult = table(
  { name: 'branch_result', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    actionId: t.u64(),        // 0 when not triggered through the action queue
    label: t.string(),
    payload: t.string(),      // JSON: the /branch response (trimmed by the engine)
    createdAt: t.timestamp(),
  }
);

export const scenarioPlan = table(
  { name: 'scenario_plan', public: true },
  {
    itemKey: t.string().primaryKey(), // client-generated; one row per plan item
    kind: t.string(),                 // storm | hazard | heat | node | ...
    payload: t.string(),              // JSON
    position: t.u32(),                // ordering in the dock
    version: t.u32(),                 // bumped on every edit (last writer wins per item)
    updatedBy: t.identity(),
    updatedByName: t.string(),
    updatedAt: t.timestamp(),
  }
);

export const campus = table(
  { name: 'campus', public: true },
  {
    id: t.string().primaryKey(),
    name: t.string(),
    lat: t.f64(),
    lng: t.f64(),
    logo: t.string(),
    tier: t.string(),          // twin | researched | illustrative
    featured: t.bool(),
    hazardCounty: t.string(),
    sortOrder: t.u32(),
  }
);

export const campusSurvey = table(
  { name: 'campus_survey', public: true },
  {
    campusId: t.string().primaryKey(),
    status: t.string(),        // running | done | error
    payload: t.string(),       // JSON summary (buildings, feeds, transit)
    updatedAt: t.timestamp(),
  }
);

// --------------------------------------------------------------------------- //
// Engine lock
// --------------------------------------------------------------------------- //

/** Singleton (id = 0). Public so the UI can tell whether an engine is live. */
export const engine = table(
  { name: 'engine', public: true },
  {
    id: t.u32().primaryKey(),
    engine: t.identity(),
    hasEngine: t.bool(),
    claimedAt: t.timestamp(),
    lastSeen: t.timestamp(),
  }
);

/** Private singleton (id = 0): the identity that first published the database. */
export const moduleOwner = table(
  { name: 'module_owner' },
  {
    id: t.u32().primaryKey(),
    owner: t.identity(),
  }
);

const spacetimedb = schema({
  node,
  edge,
  simState,
  presence,
  action,
  branchResult,
  scenarioPlan,
  campus,
  campusSurvey,
  engine,
  moduleOwner,
});
export default spacetimedb;
