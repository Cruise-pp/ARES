import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import type { ChangeEvent, ParsedChange, RunMode } from '../api/types'
import { pinCandidate, ReadCard } from '../components/ReadCard'
import { plural } from '../lib/format'
import { unmatchedQueue } from '../lib/local'
import { useReducedMotion } from '../lib/motion'

const SAMPLES = [
  'pdf-parse 2.1.4 has a CVE. Fixed in 2.1.6.',
  'pdf-parse 2.1 has a CVE',
  'customers.phone is now PII',
  'Every tool from Acme is breached.',
]

const PARSE_DEBOUNCE_MS = 450
const LEAVE_MS = 320

export function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const { graph, refresh } = useGraph()
  const reduced = useReducedMotion()
  const [text, setText] = useState<string>((location.state as { text?: string } | null)?.text ?? '')
  const [parsed, setParsed] = useState<ParsedChange | null>(null)
  const [parsedFor, setParsedFor] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const box = useRef<HTMLTextAreaElement>(null)

  const read = async (raw: string) => {
    const id = ++seq.current
    setReading(true)
    setError(null)
    try {
      const p = await api.parseChange(raw)
      if (id !== seq.current) return
      setParsed(p)
      setParsedFor(raw)
    } catch (e) {
      if (id === seq.current) setError((e as Error).message)
    } finally {
      if (id === seq.current) setReading(false)
    }
  }

  const reread = async (change: ChangeEvent) => {
    const id = ++seq.current
    setReading(true)
    try {
      const p = await api.parseChange(JSON.stringify({ ...change, source: undefined, parse: undefined }))
      if (id !== seq.current) return
      p.change.source = change.source
      setParsed(p)
      setParsedFor(text.trim())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (id === seq.current) setReading(false)
    }
  }

  useEffect(() => {
    const raw = text.trim()
    setSaved(false)
    if (raw.length < 4) {
      seq.current++
      setParsed(null)
      setParsedFor(null)
      setReading(false)
      return
    }
    if (raw === parsedFor) return
    const t = setTimeout(() => read(raw), PARSE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  useEffect(() => {
    box.current?.focus()
    refresh()
  }, [])

  const fresh = parsed !== null && parsedFor === text.trim() && !reading

  const fire = async (mode: RunMode) => {
    if (!parsed || parsed.state !== 'exact') return
    setBusy(true)
    setError(null)
    try {
      const wait = reduced ? 0 : LEAVE_MS
      const [run] = await Promise.all([
        api.postChange(parsed.change, mode),
        new Promise((r) => setTimeout(r, wait)).then(() => setLeaving(true)),
      ])
      if (wait) await new Promise((r) => setTimeout(r, LEAVE_MS))
      navigate(`/runs/${encodeURIComponent(run.run_id)}`, { state: { fresh: true } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
      setLeaving(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') setText('')
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    const raw = text.trim()
    if (!raw) return
    if (fresh && parsed?.state === 'exact') fire('live')
    else if (!fresh) read(raw)
  }

  const paused = (graph?.nodes ?? []).filter((n) => n.type === 'workflow' && n.state === 'paused').length
  const hint = reading
    ? 'Reading…'
    : parsed?.state === 'exact' && fresh
      ? '⏎ to fire · nothing changes until you do'
      : 'Plain words, a pasted advisory, or JSON'

  return (
    <main className={`home${leaving ? ' leaving' : ''}${parsed ? ' has-card' : ''}`}>
      <div className="home-col">
        <h1 className="home-title">What changed?</h1>
        <textarea
          ref={box}
          className="home-box"
          rows={2}
          value={text}
          placeholder="pdf-parse 2.1.4 has a CVE. Fixed in 2.1.6."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="What changed?"
        />
        <div className={`home-hint${reading ? ' reading' : ''}`}>{hint}</div>

        {API_MODE === 'mock' && !text && (
          <div className="home-samples">
            {SAMPLES.map((s) => (
              <button key={s} onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {parsed && (
          <div className="home-card" style={{ opacity: fresh ? 1 : 0.55 }} key={parsed.state}>
            <ReadCard
              parsed={parsed}
              graph={graph}
              busy={busy || !fresh}
              onEdit={reread}
              onPick={(id) => reread(pinCandidate(parsed.change, graph, id))}
              onFire={() => fire('live')}
              onPreview={() => fire('preview')}
              saved={saved}
              onUnmatched={() => {
                unmatchedQueue.add({
                  raw: parsed.change.source?.raw ?? text.trim(),
                  reason: parsed.reason ?? parsed.readback,
                  at: new Date().toISOString(),
                })
                setSaved(true)
              }}
            />
          </div>
        )}
      </div>

      {!text && paused > 0 && (
        <Link to="/changes" className="home-status">
          <span className="dot red" />
          {plural(paused, 'workflow')} paused right now
        </Link>
      )}
    </main>
  )
}
