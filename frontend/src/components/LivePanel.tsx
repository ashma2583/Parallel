import { useRef, useState } from 'react'
import { sendCommand, sendVoice, type CommandResult } from '../lib/api'
import type { FeedLine, Sim } from '../lib/sim'
import { strategyFor } from '../lib/strategies'
import { BriefingPanel } from './BriefingPanel'

const AGENT_COLOR: Record<string, string> = {
  Energy: 'var(--color-flow)',
  Transit: 'var(--color-warn)',
  Coordinator: 'var(--color-branch)',
  Director: 'var(--color-text)',
}

function Feed({ lines }: { lines: readonly FeedLine[] }) {
  if (lines.length === 0) return <p className="text-xs text-muted">Agents idle. The grid is balanced.</p>
  return (
    <ol className="flex flex-col gap-2.5">
      {lines.slice().reverse().map(({ tick, line }, index) => {
        const split = line.indexOf(':')
        const who = split > 0 ? line.slice(0, split) : 'System'
        return (
          <li key={`${lines.length - index}-${line}`} className="grid grid-cols-[44px_1fr] items-baseline gap-2.5">
            <span className="font-mono text-[11px] text-muted">t{tick}</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: AGENT_COLOR[who.split(' ')[0]] ?? 'var(--color-muted)' }}>
                {who}
              </div>
              <div className="mt-0.5 text-xs leading-[1.55]">{split > 0 ? line.slice(split + 1).trim() : line}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function describe({ policy }: CommandResult) {
  if (policy.action === 'reset') return 'reset campus'
  if (policy.action === 'none' || policy.node_ids.length === 0) return 'no action'
  return `${policy.action} ${policy.node_ids.join(', ')}`
}

/** Director's order: typed, or spoken while the mic button is held. */
function CommandBox({ onDone }: { onDone: (result: CommandResult) => void }) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [heard, setHeard] = useState<CommandResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  async function submit(send: () => Promise<CommandResult>) {
    setBusy(true)
    setError(null)
    try {
      const result = await send()
      setHeard(result)
      setText('')
      onDone(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

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

  const utterance = text.trim()

  return (
    <div className="border-t border-line px-4 pb-4 pt-3">
      <div className={`flex items-center gap-1 rounded-md border bg-ink p-1 ${recording ? 'border-down' : 'border-line focus-within:border-branch'}`}>
        <button
          type="button"
          disabled={busy}
          onPointerDown={() => void begin()}
          onPointerUp={end}
          onPointerLeave={() => recording && end()}
          title="Hold to talk"
          aria-label="Hold to talk"
          className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded disabled:opacity-50 ${recording ? 'bg-down text-onbranch' : 'bg-panel text-muted hover:text-text'}`}
        >
          <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden>
            <rect x="3.5" y="0.5" width="5" height="9" rx="2.5" fill="currentColor" />
            <path d="M1 7 A5 5 0 0 0 11 7 M6 12 V15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <input
          id="directors-order"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && utterance) void submit(() => sendCommand(utterance))
          }}
          disabled={busy}
          placeholder={recording ? 'Listening… release to send' : busy ? 'Working…' : 'Director’s order: the power plant just failed'}
          className="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-muted/70"
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
        </p>
      )}
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
    </div>
  )
}

const TABS = [
  { id: 'feed', label: 'Agent feed' },
  { id: 'briefing', label: 'Briefing' },
  { id: 'plan', label: 'Plan' },
] as const

interface Props {
  sim: Sim
  disrupted: boolean
  onBranch: () => void
  onCommand: (result: CommandResult) => void
  /** Planning tools: add a building to the campus, or research another place. */
  plan: React.ReactNode
}

/** Right panel while watching the live campus: current policy, feed and briefing, director's order. */
export function LivePanel({ sim, disrupted, onBranch, onCommand, plan }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('feed')
  const policy = strategyFor(sim.strategy)

  return (
    <>
      <div className="border-b border-line px-4 pb-3.5 pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Response policy</div>
        <div className="mt-1.5 text-[15px] font-semibold">{policy.label}</div>
        <div className="mt-0.5 text-xs text-muted">{policy.description}</div>
        <button
          type="button"
          onClick={onBranch}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-branch px-3.5 py-2.5 text-[13px] font-semibold text-onbranch transition hover:brightness-110"
        >
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
            <path d="M2 1 V13 M10 1 V5 C10 8 5 7 5 10 V13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Compare all five policies
        </button>
        <p className="mt-2 text-[11px] text-muted">
          {disrupted
            ? 'Forks the campus and runs each policy 6 ticks on its own copy.'
            : 'Break something first. With every building served, all five policies end in the same place.'}
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3.5">
        <div className="mb-3 flex gap-4 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] ${tab === t.id ? 'border-text text-text' : 'border-transparent text-muted'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="-mr-1.5 min-h-0 flex-1 overflow-y-auto pb-3 pr-1.5">
          {tab === 'feed' && <Feed lines={sim.activity} />}
          {tab === 'briefing' && <BriefingPanel briefing={sim.briefing} onChanged={sim.refresh} />}
          {/* Kept mounted so a half-filled form or a research result survives a tab switch. */}
          <div hidden={tab !== 'plan'} className="flex flex-col gap-6">{plan}</div>
        </div>
      </div>

      <CommandBox onDone={onCommand} />
    </>
  )
}
