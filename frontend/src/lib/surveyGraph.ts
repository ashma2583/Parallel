import type { LocationSurvey } from './api'

export interface SurveyNode {
  id: string
  name: string
  role: string
  why: string
  lat: number
  lng: number
  x: number
  y: number
  /** 'self' when this building is not on the campus plant. Otherwise the plant's id. */
  feed: string
}

export interface SurveyEdge {
  id: string
  source: string
  target: string
  kind: 'power' | 'road'
}

export interface SurveyGraphModel {
  nodes: SurveyNode[]
  edges: SurveyEdge[]
}

/** Roles decide the links. The plant feeds the campus. A hospital keeps its own supply. */
export function buildSurvey(survey: LocationSurvey): SurveyGraphModel {
  const nodes: SurveyNode[] = survey.buildings.map((building, index) => ({
    id: slug(building.name, index),
    name: building.name,
    role: building.role,
    why: building.why,
    lat: building.lat,
    lng: building.lng,
    x: 0,
    y: 0,
    feed: 'self',
  }))

  const lngs = nodes.map((node) => node.lng)
  const lats = nodes.map((node) => node.lat)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const span = Math.max(maxLng - minLng, maxLat - minLat, 0.01)
  for (const node of nodes) {
    node.x = ((node.lng - minLng) / span) * 880
    node.y = ((maxLat - node.lat) / span) * 560
  }

  const plant = nodes.find((node) => node.role === 'power')
  const hub = nodes.find((node) => node.role === 'transit')
  const edges: SurveyEdge[] = []

  if (plant) {
    for (const node of nodes) {
      if (node.id === plant.id || node.role === 'hospital' || node.role === 'power') continue
      node.feed = plant.id
      edges.push({ id: `power:${plant.id}->${node.id}`, source: plant.id, target: node.id, kind: 'power' })
    }
  }

  if (hub) {
    for (const node of nodes) {
      if (node.id === hub.id) continue
      if (node.role !== 'power' && node.role !== 'hospital') continue
      edges.push({ id: `road:${hub.id}->${node.id}`, source: hub.id, target: node.id, kind: 'road' })
    }
  }

  return { nodes, edges }
}

export function darkIds(graph: SurveyGraphModel, failed: readonly string[]): Set<string> {
  const explicit = new Set(failed)
  const dark = new Set<string>()
  for (const node of graph.nodes) {
    if (explicit.has(node.id)) dark.add(node.id)
    if (node.feed !== 'self' && explicit.has(node.feed)) dark.add(node.id)
  }
  return dark
}

function slug(name: string, index: number): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'place'
  return `${base}-${index}`
}
