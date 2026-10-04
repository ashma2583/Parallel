/**
 * A planned scenario as timed batches of hits, for Branch to play forward on
 * each policy's copy before anything lands on the live campus. Same impacts the
 * run would send to /storms/hit, on the run's clock: 1 s at 1x is one tick.
 */
import type { ProposalPin } from '../api'
import type { SimEdge, SimNode } from '../sim'
import { runDuration } from './geo'
import { buildWorld, computeImpacts, stormLabel } from './impacts'
import { eventLabel, planTotal, radiusOf, startClock } from './plan'
import { FAULT_SPECS, HAZARD_SPECS, STORM_SPECS, type BusLine, type ClosedRoute, type EdgeMark, type ScenarioPlan } from './types'

/** What lands at one tick, counted from the fork. Same shapes as a storm hit. */
export interface ScenarioBatch {
  tick: number
  /** A campus condition, applied the way the hazard button does. Extreme heat starts the four-hour ramp. */
  hazard?: string
  fail: string[]
  derate: { node_id: string; factor: number }[]
  cut_edges: EdgeMark[]
  close_roads: EdgeMark[]
  close_routes: ClosedRoute[]
}

export interface PlannedScenario {
  /** Events in the plan. */
  events: number
  /** "EF3 tornado + Extreme cold". */
  names: string[]
  /** Clock time the last event finishes, "HH:MM". */
  through: string
  /** The run is playing now. The copies replay it from its start. */
  running: boolean
  batches: ScenarioBatch[]
}

interface Campus {
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  proposals: readonly ProposalPin[]
  buses: readonly BusLine[]
}

/**
 * Every impact the plan would send, grouped by tick. Scored against a campus with
 * nothing down: a fail on a building already down does nothing, so the copy ends
 * up where the run would, whether or not an earlier run left damage behind.
 */
export function planScenario(plan: ScenarioPlan, campus: Campus, running = false): PlannedScenario | null {
  if (plan.events.length === 0) return null
  const up = campus.nodes.map((node) => (node.failed ? { ...node, failed: false } : node))
  const world = buildWorld(up, campus.edges, campus.proposals, campus.buses)
  const byTick = new Map<number, ScenarioBatch>()
  const at = (tick: number) => {
    let batch = byTick.get(tick)
    if (!batch) {
      batch = { tick, fail: [], derate: [], cut_edges: [], close_roads: [], close_routes: [] }
      byTick.set(tick, batch)
    }
    return batch
  }

  for (const event of plan.events) {
    if (event.type === 'hazard') {
      // Two conditions in the same second each get their own batch slot.
      const tick = Math.round(event.start)
      const batch = at(tick)
      if (batch.hazard) at(tick + 1).hazard = HAZARD_SPECS[event.hazard].hazardId
      else batch.hazard = HAZARD_SPECS[event.hazard].hazardId
      continue
    }
    if (event.type === 'fault') {
      const batch = at(Math.round(event.start))
      for (const id of FAULT_SPECS[event.fault].nodeIds) if (!batch.fail.includes(id)) batch.fail.push(id)
      continue
    }
    const stormId = `plan-${event.id}`
    const storm = {
      id: stormId,
      kind: event.kind,
      level: event.level,
      path: event.path,
      radius: radiusOf(event.kind, event.level),
      label: stormLabel(event.kind, event.level),
    }
    const seconds = runDuration(event.kind, event.path, STORM_SPECS[event.kind].msPerKm) / 1000
    for (const impact of computeImpacts(storm, world)) {
      const batch = at(Math.round(event.start + impact.t * seconds))
      if (impact.action === 'fail' || impact.action === 'cut') {
        for (const id of impact.nodeIds) if (!batch.fail.includes(id)) batch.fail.push(id)
      }
      if (impact.action === 'derate' && impact.factor !== undefined) {
        for (const id of impact.nodeIds) batch.derate.push({ node_id: id, factor: impact.factor })
      }
      if (impact.edgeId && impact.target === 'line') batch.cut_edges.push({ id: impact.edgeId, at: impact.at, storm_id: stormId })
      if (impact.edgeId && impact.target === 'road') batch.close_roads.push({ id: impact.edgeId, at: impact.at, storm_id: stormId })
      if (impact.target === 'bus' && impact.route) {
        const { id, name, segments } = impact.route
        batch.close_routes.push({ id, name, segments, reason: impact.detail, storm_id: stormId })
      }
    }
  }

  return {
    events: plan.events.length,
    names: plan.events.map(eventLabel),
    through: startClock(plan.startsAt, planTotal(plan.events, 1) / 1000),
    running,
    batches: [...byTick.values()].sort((a, b) => a.tick - b.tick),
  }
}
