import { useRef, useState } from 'react'
import { sendCommand, sendVoice } from '../lib/api'

export function VoicePanel() {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [heard, setHeard] = useState<string | null>(null)
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
        void submit(blob)
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

  async function submit(blob: Blob) {
    setBusy(true)
    try {
      const result = await sendVoice(blob)
      setHeard(format(result.transcript, result.policy.action, result.policy.node_ids, result.policy.parser))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitText() {
    const utterance = text.trim()
    if (!utterance) return
    setBusy(true)
    setError(null)
    try {
      const result = await sendCommand(utterance)
      setHeard(format(result.transcript, result.policy.action, result.policy.node_ids, result.policy.parser))
      setText('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Voice order</h2>
      <button
        disabled={busy}
        onPointerDown={() => void begin()}
        onPointerUp={end}
        onPointerLeave={() => recording && end()}
        className={`w-full rounded-md px-3 py-2 text-sm font-semibold transition disabled:opacity-50 ${
          recording ? 'bg-red-500 text-white' : 'border border-slate-700 bg-slate-900 text-slate-100 hover:border-sky-500'
        }`}
      >
        {recording ? 'Listening… release to send' : busy ? 'Working…' : 'Hold to talk'}
      </button>
      <div className="mt-2 flex gap-1.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitText()
          }}
          placeholder="or type: the power plant just failed"
          className="min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-600"
        />
        <button
          disabled={busy || !text.trim()}
          onClick={() => void submitText()}
          className="rounded-md bg-sky-500/20 px-2 text-xs font-semibold text-sky-200 disabled:opacity-40"
        >
          Send
        </button>
      </div>
      {heard && <p className="mt-2 text-xs text-slate-300">{heard}</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  )
}

function format(transcript: string, action: string, nodeIds: string[], parser: string) {
  const target = action === 'reset' ? 'campus' : action === 'none' ? 'nothing' : nodeIds.join(', ') || 'nothing'
  return `“${transcript}” → ${action} ${target} (${parser})`
}
