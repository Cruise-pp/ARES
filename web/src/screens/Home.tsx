import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError, API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import type { ChangeEvent, ParsedChange, RunMode } from '../api/types'
import { pinCandidate, ReadCard } from '../components/ReadCard'
import { plural } from '../lib/format'
import { abort, launch } from '../lib/handoff'
import { unmatchedQueue } from '../lib/local'
import { useReducedMotion } from '../lib/motion'

const SAMPLES: { label: string; text: string }[] = [
  {
    label: 'pdf-parse 2.1.4',
    text: 'tool: pdf-parse\nversion: 2.1.4\necosystem: npm\ncve: CVE-2026-4471\nfixed: 2.1.6',
  },
  {
    label: 'pdf-parse 2.1, pick one',
    text: 'tool: pdf-parse\nversion: 2.1\ncve: CVE-2026-4471',
  },
  {
    label: 'customers.phone is PII',
    text: 'table: customers\ncolumn: phone\nclassification: PII',
  },
  {
    label: 'a sentence',
    text: 'Vendor says pdf-parse 2.1.4 has a remote code bug, CVE-2026-4471. Fixed in 2.1.6.',
  },
]

const PARSE_DEBOUNCE_MS = 450

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
    // Live: each parse is stored. Read on Enter or a sample, not on every pause in typing.
    if (API_MODE === 'live') {
      if (raw.length < 4) {
        seq.current++
        setParsed(null)
        setParsedFor(null)
        setReading(false)
      }
      return
    }
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
    const button = document.querySelector<HTMLElement>(mode === 'live' ? '.home-card .btn.primary' : '.home-card .btn:not(.primary)')
    const covered = !reduced && button ? launch(button.getBoundingClientRect()) : Promise.resolve()
    if (!reduced) setLeaving(true)
    try {
      const [run] = await Promise.all([api.postChange(parsed.change, mode), covered])
      navigate(`/runs/${encodeURIComponent(run.run_id)}`, { state: { fresh: true } })
    } catch (e) {
      abort()
      const body = e instanceof ApiError ? e.body : undefined
      if (e instanceof ApiError && e.status === 409 && body && typeof body === 'object' && 'state' in body && 'change' in body) {
        setParsed(body as ParsedChange)
        setParsedFor(text.trim())
        setError(null)
      } else {
        setError((e as Error).message)
      }
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
      : API_MODE === 'live'
        ? '⏎ to read · plain words, a pasted advisory, or JSON'
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

        {!text && (
          <div className="home-samples">
            {SAMPLES.map((s) => (
              <button
                key={s.label}
                onClick={() => {
                  setText(s.text)
                  read(s.text)
                }}
              >
                {s.label}
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
