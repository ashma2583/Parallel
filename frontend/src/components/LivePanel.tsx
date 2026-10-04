import { useRef, useState } from 'react'
import { sendCommand, sendVoice, type CommandResult, type Hazard } from '../lib/api'
import type { FeedLine, ScenarioFeed, Sim } from '../lib/sim'
import { strategyFor } from '../lib/strategies'
import { BriefingPanel } from './BriefingPanel'

const AGENT_COLOR: Record<string, string> = {
  Energy: 'var(--color-flow)',
  Transit: 'var(--color-warn)',
  Coordinator: 'var(--color-branch)',
  Director: 'var(--color-text)',
  Weather: 'var(--color-transit)',
  Planner: 'var(--color-branch)',
}

function Feed({ scenarios, clockAt }: { scenarios: readonly ScenarioFeed[]; clockAt: (tick: number) => string }) {
  const latest = scenarios[scenarios.length - 1]
  const [picked, setPicked] = useState<number | null>(null)
  const viewing = scenarios.find((scenario) => scenario.id === picked) ?? latest
  const lines: readonly FeedLine[] = viewing?.lines ?? []

  if (!latest) return <p className="text-sm text-muted">Agents idle. The grid is balanced.</p>
  return (
    <div className="flex flex-col gap-3">
      {scenarios.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {scenarios.map((scenario) => {
            const on = scenario.id === viewing?.id
            return (
              <button
                key={scenario.id}
                type="button"
                onClick={() => setPicked(scenario.id === latest.id ? null : scenario.id)}
                className={`rounded-full border px-2.5 py-1 text-[13px] font-medium ${on ? 'border-branch text-branch' : 'border-line text-muted'}`}
              >
                {scenario.label}
              </button>
            )
          })}
        </div>
      )}
      {lines.length === 0 ? (
        <p className="text-sm text-muted">Agents idle. The grid is balanced.</p>
      ) : (
    <ol className="flex flex-col gap-2.5">
      {lines.slice().reverse().map(({ tick, line }, index) => {
        const split = line.indexOf(':')
        const who = split > 0 ? line.slice(0, split) : 'System'
        return (
          <li key={`${lines.length - index}-${line}`} className="grid grid-cols-[52px_1fr] items-baseline gap-2.5">
            <span className="font-mono text-sm tabular-nums text-muted">{clockAt(tick)}</span>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.12em]" style={{ color: AGENT_COLOR[who.split(' ')[0]] ?? 'var(--color-muted)' }}>
                {who}
              </div>
              <div className="mt-0.5 text-[16px] leading-[1.5]">{split > 0 ? line.slice(split + 1).trim() : line}</div>
            </div>
          </li>
        )
      })}
    </ol>
      )}
    </div>
  )
}

function describe({ policy }: CommandResult) {
  if (policy.action === 'reset') return 'reset campus'
  if (policy.action === 'heat_wave') return 'heat wave'
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
          className="min-w-0 flex-1 bg-transparent px-1.5 text-base outline-none placeholder:text-muted/70"
        />
        <button
          type="button"
          disabled={busy || !utterance}
          onClick={() => void submit(() => sendCommand(utterance))}
          className="rounded px-2.5 py-1.5 text-sm font-semibold text-branch disabled:opacity-30"
        >
          Send
        </button>
      </div>
      {heard && (
        <p className="mt-2 text-[15px] text-muted">
          Understood as <span className="font-mono text-text">{describe(heard)}</span>
        </p>
      )}
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
    </div>
  )
}

const TABS = [
  { id: 'feed', label: 'Agent feed' },
  { id: 'briefing', label: 'Briefing' },
  { id: 'plan', label: 'Plan' },
  { id: 'people', label: 'People' },
] as const

interface Props {
  sim: Sim
  disrupted: boolean
  /** A scenario is playing on the map. Comparing waits until it ends, unless there is a plan to replay. */
  running?: boolean
  /** The scenario dock has a plan the last run has not played. Branch plays it forward. */
  planned?: boolean
  /** Time of day at an engine tick, from the one sim clock. */
  clockAt: (tick: number) => string
  /** Heat-wave demo: point at the briefing, the feed, and the policy comparison. */
  demo?: boolean
  onBranch: () => void
  onCommand: (result: CommandResult) => void
  /** Planning tools: add a building to the campus, or research another place. */
  plan: React.ReactNode
  /** Students in class by time of day. */
  people: React.ReactNode
  /** The hazard that started this scenario, if one did. */
  hazard: Hazard | null
}

/** Right panel while watching the live campus: current policy, feed and briefing, director's order. */
export function LivePanel({ sim, disrupted, running = false, planned = false, demo = false, onBranch, onCommand, plan, people, hazard, clockAt }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('briefing')
  const [cue, setCue] = useState(demo)
  const policy = strategyFor(sim.strategy)

  return (
    <>
      {cue && (
        <div className="border-b border-branch bg-branch/15 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[16px] font-medium leading-snug">
              This panel is the desk. <span className="text-branch">Briefing</span> says where to cool off and which buses still run. <span className="text-branch">Agent feed</span> is the energy and transit agents as the heat builds. Then compare the five policies.
            </p>
            <button type="button" onClick={() => setCue(false)} className="text-[18px] leading-none text-muted" aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
      <div className="border-b border-line px-4 pb-3.5 pt-4">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Response policy</div>
        <div className="mt-1.5 text-[22px] font-semibold">{policy.label}</div>
        <div className="mt-0.5 text-[16px] text-muted">{policy.description}</div>
        <button
          type="button"
          onClick={onBranch}
          disabled={running && !planned}
          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-branch px-3.5 py-2.5 text-[16px] font-semibold text-onbranch transition enabled:hover:brightness-110 disabled:bg-raised disabled:text-faint ${demo ? 'demo-button' : ''}`}
        >
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
            <path d="M2 1 V13 M10 1 V5 C10 8 5 7 5 10 V13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Compare all five policies
        </button>
        <p className="mt-2 text-[15px] text-muted">
          {planned
            ? running
              ? 'Replays the scenario playing now from its start, on a copy of the campus for each policy.'
              : 'Plays your planned scenario forward on a copy of the campus for each policy, before it hits the live one.'
            : running
            ? 'Finish or stop the scenario run first. A comparison forked mid-run is out of date before it shows.'
            : disrupted
              ? sim.briefing?.heat_wave && sim.briefing.heat_wave.step < sim.briefing.heat_wave.span
                ? 'Forks the campus and runs each policy through the heat peak on its own copy.'
                : 'Forks the campus and runs each policy the next 24 minutes on its own copy.'
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
              className={`-mb-px border-b pb-2 text-[13px] font-semibold uppercase tracking-[0.14em] ${
                tab === t.id ? 'border-text text-text' : demo ? 'border-transparent text-branch' : 'border-transparent text-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="-mr-1.5 min-h-0 flex-1 overflow-y-auto pb-3 pr-1.5">
          {tab === 'feed' && <Feed scenarios={sim.scenarios} clockAt={clockAt} />}
          {tab === 'briefing' && <BriefingPanel briefing={sim.briefing} hazard={hazard} onChanged={sim.refresh} />}
          {/* Kept mounted so a half-filled form or a research result survives a tab switch. */}
          <div hidden={tab !== 'plan'} className="flex flex-col gap-6">{plan}</div>
          {tab === 'people' && people}
        </div>
      </div>

      <CommandBox onDone={onCommand} />
    </>
  )
}
