import { useEffect, useMemo, useRef, useState } from 'react'
import cityRendererUrl from '../../../design/Improvements/city3d.js?url'
import { PLACES } from '../lib/places'
import type { SimEdge, SimNode } from '../lib/sim'

interface CityNode extends SimNode {
  short: string
}

interface CityColors {
  ground: string
  plane: string
  roadMajor: string
  road: string
  lit: string
  litDeep: string
  darkBld: string
  reduced: string
  filler: string
  pin: string
  pinOff: string
  pinOffBolt: string
  text: string
}

interface CityRendererInstance {
  setNodes: (nodes: CityNode[]) => void
  setSelected: (id: string | null) => void
  resize: () => void
  destroy: () => void
}

declare global {
  interface Window {
    CityRenderer?: new (
      canvas: HTMLCanvasElement,
      options: {
        geo: Record<string, [number, number]>
        nodes: CityNode[]
        edges: SimEdge[]
        colors: CityColors
        onSelect: (id: string | null) => void
      },
    ) => CityRendererInstance
  }
}

const GEO = Object.fromEntries(Object.entries(PLACES).map(([id, place]) => [id, [place.lng, place.lat]])) as Record<
  string,
  [number, number]
>

let rendererLoad: Promise<void> | null = null

function loadRenderer() {
  if (window.CityRenderer) return Promise.resolve()
  if (!rendererLoad) {
    rendererLoad = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = cityRendererUrl
      script.onload = () => {
        if (window.CityRenderer) resolve()
        else reject(new Error('The city renderer script loaded without exposing CityRenderer.'))
      }
      script.onerror = () => reject(new Error('Could not load the city renderer script.'))
      document.head.append(script)
    }).catch((error: unknown) => {
      rendererLoad = null
      throw error
    })
  }
  return rendererLoad
}

function color(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function cityColors(): CityColors {
  return {
    ground: color('--city-ground', '#0b1424'),
    plane: color('--city-plane', '#0d1929'),
    roadMajor: color('--city-road-major', '#1d2a3d'),
    road: color('--city-road', '#152238'),
    lit: color('--city-lit', '#5ec8ff'),
    litDeep: color('--city-lit-deep', '#287cad'),
    darkBld: color('--city-dark-building', '#253047'),
    reduced: color('--city-reduced', '#ffb24d'),
    filler: color('--city-filler', '#122036'),
    pin: color('--city-pin', '#5ec8ff'),
    pinOff: color('--city-pin-off', '#ff6b6b'),
    pinOffBolt: color('--city-pin-off-bolt', '#e6edf7'),
    text: color('--city-text', '#e6edf7'),
  }
}

interface Props {
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId: string | null
  onNodeClick: (node: SimNode) => void
}

export function CityCanvas({ nodes, edges, selectedId, onNodeClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<CityRendererInstance | null>(null)
  const onNodeClickRef = useRef(onNodeClick)
  const [error, setError] = useState<string | null>(null)
  const cityNodes = useMemo(
    () => nodes.map((node) => ({ ...node, short: PLACES[node.id]?.short ?? node.name })),
    [nodes],
  )
  const latest = useRef({ nodes, cityNodes, edges, selectedId })

  useEffect(() => {
    onNodeClickRef.current = onNodeClick
  }, [onNodeClick])

  useEffect(() => {
    latest.current = { nodes, cityNodes, edges, selectedId }
  }, [nodes, cityNodes, edges, selectedId])

  useEffect(() => {
    let disposed = false
    let instance: CityRendererInstance | null = null
    const canvas = canvasRef.current
    if (!canvas) return

    void loadRenderer()
      .then(() => {
        if (disposed) return
        const Constructor = window.CityRenderer
        if (!Constructor) throw new Error('CityRenderer is unavailable after loading.')
        const current = latest.current
        instance = new Constructor(canvas, {
          geo: GEO,
          nodes: current.cityNodes,
          edges: [...current.edges],
          colors: cityColors(),
          onSelect: (id) => {
            const node = latest.current.nodes.find((candidate) => candidate.id === id)
            if (node) onNodeClickRef.current(node)
          },
        })
        rendererRef.current = instance
        instance.setSelected(current.selectedId)
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      disposed = true
      instance?.destroy()
      if (rendererRef.current === instance) rendererRef.current = null
    }
  }, [])

  useEffect(() => {
    rendererRef.current?.setNodes(cityNodes)
  }, [cityNodes])

  useEffect(() => {
    rendererRef.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!container) return
    const observer = new ResizeObserver(() => rendererRef.current?.resize())
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--city-ground)]">
      <canvas ref={canvasRef} aria-label="Interactive 3D campus simulation" className="block h-full w-full" />
      {error && (
        <div role="alert" className="absolute inset-x-4 top-4 rounded-md border border-down bg-panel/95 px-3 py-2 text-xs text-down">
          City view failed to load: {error}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-4 font-mono text-[10px] text-muted">
        drag to orbit · shift-drag to pan · scroll to zoom · click a pin
      </div>
    </div>
  )
}
