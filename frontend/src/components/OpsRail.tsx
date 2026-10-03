import { useRef, useState } from 'react'
import { disrupt, sendCommand, sendVoice, type CommandResult } from '../lib/api'
import { isSupplier, type Sim, type SimNode } from '../lib/sim'
import { PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL, fmtKw, statusColor, type Status } from '../lib/status'

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h2>
}

function CommandBox({ onDone }: { onDone: () => void }) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [heard, setHeard] = useState<CommandResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  async function begin() {
    setError(null)
    setHeard(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
        void submit(() => sendVoice(blob))
      }
      rec.start()
      recorder.current = rec
      setRecording(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function end() {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    setRecording(false)
  }

  async function submit(send: () => Promise<CommandResult>) {
    setBusy(true)
    setError(null)
    try {
      setHeard(await send())
      setText('')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const utterance = text.trim()

  return (
    <section>
      <Heading>Director&rsquo;s order</Heading>
      <div className={`flex items-center gap-1 rounded-md border bg-ink p-1 transition ${recording ? 'border-down' : 'border-line focus-within:border-branch'}`}>
        <button
          type="button"
          disabled={busy}
          onPointerDown={() => void begin()}
          onPointerUp={end}
          onPointerLeave={() => recording && end()}
          title="Hold to talk"
          aria-label="Hold to talk"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded transition disabled:opacity-50 ${
            recording ? 'bg-down text-ink' : 'bg-raised text-muted hover:text-text'
          }`}
        >
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden>
            <rect x="3.5" y="0.5" width="5" height="9" rx="2.5" fill="currentColor" />
            <path d="M1 7 A5 5 0 0 0 11 7 M6 12 V15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && utterance) void submit(() => sendCommand(utterance))
          }}
          disabled={busy}
          placeholder={recording ? 'Listening… release to send' : busy ? 'Working…' : 'The power plant just failed'}
          className="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-faint"
        />
        <button
          type="button"
          disabled={busy || !utterance}
          onClick={() => void submit(() => sendCommand(utterance))}
          className="rounded px-2.5 py-1.5 text-xs font-semibold text-branch disabled:opacity-30"
        >
          Send
        </button>
      </div>
      {heard && (
        <p className="mt-2 text-xs text-muted">
          Understood as <span className="font-mono text-text">{describe(heard)}</span>
          <span className="text-faint"> · {heard.policy.parser} parser</span>
        </p>
      )}
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
    </section>
  )
}

function describe({ policy }: CommandResult) {
  if (policy.action === 'reset') return 'reset campus'
  if (policy.action === 'none' || policy.node_ids.length === 0) return 'no action'
  return `${policy.action} ${policy.node_ids.join(', ')}`
}

function Inspector({ node, onDone }: { node: SimNode | undefined; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  if (!node) {
    return (
      <section>
        <Heading>Inspector</Heading>
        <p className="text-xs text-faint">Click a building on the map to inspect it.</p>
      </section>
    )
  }
  const supplier = isSupplier(node)
  const color = statusColor(node.status)
  const toggle = async () => {
    setBusy(true)
    try {
      await disrupt([node.id], node.failed ? 'restore' : 'fail', 'Manual override')
      onDone()
    } finally {
      setBusy(false)
    }
  }
  const rows: [string, string][] = [
    ['Type', TYPE_LABEL[node.type] ?? node.type],
    ['Priority', PRIORITY_LABEL[node.priority] ?? node.priority],
    [supplier ? 'Output' : 'Receiving', fmtKw(node.currentPower)],
    [supplier ? 'Capacity' : 'Wants', fmtKw(supplier ? node.capacity : node.demand)],
    ['People', node.occupancy.toLocaleString()],
    ['Load shed', `${Math.round(node.loadShed * 100)}%`],
  ]
  return (
    <section>
      <Heading>Inspector</Heading>
      <div className="flex items-start justify-between gap-3">
        <div className="text-[15px] font-semibold leading-snug">{node.name}</div>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs font-medium" style={{ color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {node.failed ? 'Offline' : (STATUS_LABEL[node.status as Status] ?? node.status)}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</dt>
            <dd className="font-mono text-[13px] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        className={`mt-3.5 w-full rounded-md border px-3 py-1.5 text-[13px] font-medium transition disabled:opacity-50 ${
          node.failed ? 'border-ok/40 text-ok hover:bg-ok/10' : 'border-down/40 text-down hover:bg-down/10'
        }`}
      >
        {node.failed ? 'Restore this node' : 'Fail this node'}
      </button>
    </section>
  )
}

const AGENT_COLOR: Record<string, string> = {
  Energy: 'var(--color-flow)',
  Transit: 'var(--color-transit)',
  Coordinator: 'var(--color-branch)',
  Director: 'var(--color-text)',
}

function Feed({ lines }: { lines: readonly string[] }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Heading>Agent feed</Heading>
      {lines.length === 0 ? (
        <p className="text-xs text-faint">Agents idle. The grid is balanced.</p>
      ) : (
        <ol className="-mr-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
          {lines.slice().reverse().map((line, index) => {
            const split = line.indexOf(':')
            const who = split > 0 ? line.slice(0, split) : 'System'
            const agent = who.split(' ')[0]
            return (
              <li key={`${lines.length - index}-${line}`}>
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: AGENT_COLOR[agent] ?? 'var(--color-faint)' }} />
                  {who}
                </div>
                <div className="mt-0.5 text-xs leading-relaxed text-text/80">{split > 0 ? line.slice(split + 1).trim() : line}</div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

interface Props {
  sim: Sim
  selected: SimNode | undefined
}

export function OpsRail({ sim, selected }: Props) {
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-7 border-l border-line bg-panel p-4">
      <CommandBox onDone={sim.refresh} />
      <Inspector node={selected} onDone={sim.refresh} />
      <Feed lines={sim.activity} />
    </aside>
  )
}
