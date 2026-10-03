/**
 * One view of the simulation for the whole UI.
 *
 * SpacetimeDB subscriptions are the primary source. If SpacetimeDB is down the
 * hook reads the same state from the engine's `/state` endpoint once a second,
 * so the console keeps working with only the FastAPI process running.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSpacetimeDB, useTable } from 'spacetimedb/react'
import { BACKEND_URL } from '../config'
import { tables } from '../module_bindings'
import { PLACES, ZONES } from './places'

export interface SimNode {
  id: string
  name: string
  type: string
  priority: string
  capacity: number
  demand: number
  currentPower: number
  occupancy: number
  status: string
  failed: boolean
  loadShed: number
  powerRatio: number
  x: number
  y: number
}

export interface SimEdge {
  id: string
  source: string
  target: string
  type: string
}

export interface SimSummary {
  tick: number
  supply: number
  demand: number
  deficit: number
}

/** A node as the FastAPI engine serializes it. */
export interface ApiNode {
  id: string
  name: string
  type: string
  priority: string
  capacity: number
  demand: number
  current_power: number
  occupancy: number
  status: string
  failed: boolean
  load_shed: number
  power_ratio: number
  position?: { x?: number; y?: number }
}

export function fromApiNode(n: ApiNode): SimNode {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    priority: n.priority,
    capacity: n.capacity,
    demand: n.demand,
    currentPower: n.current_power,
    occupancy: n.occupancy,
    status: n.status,
    failed: n.failed,
    loadShed: n.load_shed,
    powerRatio: n.power_ratio,
    x: n.position?.x ?? 0,
    y: n.position?.y ?? 0,
  }
}

export type Source = 'spacetimedb' | 'engine' | 'offline'

export interface Sim {
  source: Source
  nodes: SimNode[]
  edges: SimEdge[]
  summary: SimSummary | undefined
  activity: string[]
  strategy: string
  /** Pull engine state now instead of waiting for the next poll. */
  refresh: () => void
}

interface EngineState {
  nodes: SimNode[]
  edges: SimEdge[]
  summary: SimSummary | undefined
}

export function useSim(): Sim {
  const { isActive } = useSpacetimeDB()
  const [nodeRows] = useTable(tables.node)
  const [edgeRows] = useTable(tables.edge)
  const [simRows] = useTable(tables.simState)
  const stdbLive = isActive && nodeRows.length > 0

  const [engine, setEngine] = useState<EngineState | null>(null)
  const [engineUp, setEngineUp] = useState(false)
  const [activity, setActivity] = useState<string[]>([])
  const [strategy, setStrategy] = useState('tiered')

  const stdbLiveRef = useRef(stdbLive)
  useEffect(() => {
    stdbLiveRef.current = stdbLive
  }, [stdbLive])

  const pull = useCallback(async () => {
    try {
      // With SpacetimeDB live only the agent feed comes over REST.
      const res = await fetch(`${BACKEND_URL}${stdbLiveRef.current ? '/activity' : '/state'}`)
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      setEngineUp(true)
      setStrategy(data.strategy ?? 'tiered')
      if (stdbLiveRef.current) {
        setActivity(data.lines ?? [])
        return
      }
      setActivity(data.activity ?? [])
      setEngine({
        nodes: (data.nodes as ApiNode[]).map(fromApiNode),
        edges: data.edges,
        summary: data.summary && {
          tick: data.summary.tick,
          supply: data.summary.supply,
          demand: data.summary.demand,
          deficit: data.summary.deficit,
        },
      })
    } catch {
      setEngineUp(false)
    }
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void pull(), 0)
    const timer = setInterval(() => void pull(), 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [pull])

  return useMemo(() => {
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
    if (stdbLive) {
      const s = simRows[0]
      return {
        source: 'spacetimedb',
        nodes: [...nodeRows].sort(byId),
        edges: [...edgeRows],
        summary: s && { tick: Number(s.tick), supply: s.supply, demand: s.demand, deficit: s.deficit },
        activity,
        strategy,
        refresh: pull,
      }
    }
    if (engineUp && engine) {
      return { source: 'engine', ...engine, nodes: [...engine.nodes].sort(byId), activity, strategy, refresh: pull }
    }
    return { source: 'offline', nodes: [], edges: [], summary: undefined, activity, strategy, refresh: pull }
  }, [stdbLive, nodeRows, edgeRows, simRows, engine, engineUp, activity, strategy, pull])
}

export const isSupplier = (n: SimNode) => n.type === 'substation'

/** Delivered kW over wanted kW. Same definition as `_served` in backend/branch.py. */
function served(nodes: SimNode[]): number {
  const wanted = nodes.reduce((sum, n) => sum + n.demand, 0)
  if (wanted <= 0) return 1
  return nodes.reduce((sum, n) => sum + n.currentPower, 0) / wanted
}

export function essentialServed(nodes: SimNode[]): number {
  return served(nodes.filter((n) => !isSupplier(n) && (n.priority === 'critical' || n.priority === 'high')))
}

export interface ZoneLoad {
  zone: string
  served: number
  demand: number
  dark: number
}

export function zoneLoads(nodes: SimNode[]): ZoneLoad[] {
  return ZONES.map((zone) => {
    const members = nodes.filter((n) => !isSupplier(n) && PLACES[n.id]?.zone === zone)
    return {
      zone,
      served: served(members),
      demand: members.reduce((sum, n) => sum + n.demand, 0),
      dark: members.filter((n) => n.status === 'Red').length,
    }
  })
}
