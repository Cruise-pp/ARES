import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import type { ChangeEvent, ParsedChange, RunMode } from '../api/types'
import { pinCandidate, ReadCard } from '../components/ReadCard'
import { unmatchedQueue } from '../lib/local'

const SAMPLES = [
  'Vendor says pdf-parse 2.1.4 has a remote code bug, CVE-2026-4471. Fixed in 2.1.6.',
  'pdf-parse 2.1 has a CVE',
  'Data steward: customers.phone is now personal data (PII).',
  'New rule: all models must run in the EU.',
  'gpt-x retires on Friday.',
  'Every tool from Acme is breached.',
]

const PARSE_DEBOUNCE_MS = 450

export function EnterChange() {
  const navigate = useNavigate()
  const location = useLocation()
  const { graph } = useGraph()
  const [text, setText] = useState<string>((location.state as { text?: string } | null)?.text ?? '')
  const [parsed, setParsed] = useState<ParsedChange | null>(null)
  const [parsedFor, setParsedFor] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
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
  }, [])

  const fresh = parsed !== null && parsedFor === text.trim() && !reading

  const fire = async (mode: RunMode) => {
    if (!parsed || parsed.state !== 'exact') return
    setBusy(true)
    setError(null)
    try {
      const run = await api.postChange(parsed.change, mode)
      navigate(`/runs/${encodeURIComponent(run.run_id)}`, { state: { fresh: true } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') navigate('/')
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    const raw = text.trim()
    if (!raw) return
    if (fresh && parsed?.state === 'exact') fire('live')
    else if (!fresh) read(raw)
  }

  return (
    <main className="page">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 12 }}>
        <h1 className="page-title">Enter a change</h1>
        <Link to="/" className="muted" style={{ fontSize: 13 }}>
          ← Changes
        </Link>
      </div>

      <textarea
        ref={box}
        className="enter-box"
        rows={2}
        value={text}
        placeholder="pdf-parse 2.1.4 has a CVE. Fixed in 2.1.6."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Enter a change"
      />
      <div className="enter-hint">
        <span>Plain words, a pasted advisory, or JSON. Radius reads all three.</span>
        <span>·</span>
        <span>⏎ fires when the match is exact</span>
        {reading && <span style={{ color: 'var(--blue)' }}>· reading…</span>}
      </div>

      {API_MODE === 'mock' && !text && (
        <div className="samples">
          {SAMPLES.map((s) => (
            <button key={s} className="sample" onClick={() => setText(s)}>
              {s.length > 52 ? `${s.slice(0, 50)}…` : s}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="error-box" style={{ marginBottom: 14, maxWidth: 560 }}>
          {error}
        </div>
      )}

      {parsed && (
        <div style={{ opacity: fresh ? 1 : 0.5, transition: 'opacity .15s' }}>
          <ReadCard
            parsed={parsed}
            graph={graph}
            busy={busy || !fresh}
            onEdit={reread}
            onPick={(id) => reread(pinCandidate(parsed.change, graph, id))}
            onFire={() => fire('live')}
            onPreview={() => fire('preview')}
            onUnmatched={() => {
              unmatchedQueue.add({
                raw: parsed.change.source?.raw ?? text.trim(),
                reason: parsed.reason ?? parsed.readback,
                at: new Date().toISOString(),
              })
              navigate('/')
            }}
          />
        </div>
      )}
    </main>
  )
}
