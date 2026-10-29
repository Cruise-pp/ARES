import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API_MODE } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { FeedRow } from '../api/types'
import { Freshness } from '../components/Shell'
import { kindLabel, plural, reachText, rowTone, splitTitle, timeAgo } from '../lib/format'
import { clearLocal, unmatchedQueue, type UnmatchedItem } from '../lib/local'

export function runLink(row: FeedRow): string | null {
  return row.run_id ? `/runs/${encodeURIComponent(row.run_id)}` : null
}

export function Feed() {
  const navigate = useNavigate()
  const { graph, refresh } = useGraph()
  const feed = useAsync(() => api.getChanges(), [])
  const [unmatched, setUnmatched] = useState<UnmatchedItem[]>(unmatchedQueue.list)

  useEffect(() => {
    refresh()
    const t = setInterval(() => feed.reload(), 15_000)
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return
      if (e.key === '/' || e.key === 'n') {
        e.preventDefault()
        navigate('/')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const rows = feed.data ?? []
  const pausedNow = (graph?.nodes ?? []).filter((n) => n.type === 'workflow' && n.state === 'paused').length

  const resetMock = async () => {
    const m = await import('../mocks/server')
    m.resetMock()
    clearLocal()
    setUnmatched([])
    refresh()
    feed.reload()
  }

  return (
    <main className="page">
      {feed.error && <div className="error-box">Radius cannot load the feed. {feed.error.message}</div>}
      {feed.loading && !feed.data && <div className="loading">Loading changes…</div>}

      {feed.data && rows.length === 0 && (
        <div className="card empty-state">
          <div className="big">0 changes checked · nothing paused</div>
          <p className="muted">Radius watches the CVE feed, the data catalog and the policy register.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: '6px 8px 8px' }}>
          <div className="feed-head" role="row">
            <span />
            <span>Change</span>
            <span>Kind</span>
            <span>Reaches</span>
            <span>State</span>
            <span />
          </div>
          {rows.map((row) => {
            const tone = rowTone(row.state)
            const [main, sub] = splitTitle(row.title)
            const href = runLink(row)
            return (
              <div
                key={`${row.change_id}-${row.at}`}
                className={`feed-row ${tone}`}
                role={href ? 'link' : undefined}
                tabIndex={href ? 0 : undefined}
                onClick={() => href && navigate(href)}
                onKeyDown={(e) => href && e.key === 'Enter' && navigate(href)}
              >
                <span className={`dot ${tone}`} />
                <span>
                  <div className="title">{main}</div>
                  {sub && <div className="sub">{sub}</div>}
                </span>
                <span className="muted">{kindLabel(row.kind)}</span>
                <span>{reachText(row.reach)}</span>
                <span>
                  <span className={`badge ${tone}`}>{row.state}</span>
                </span>
                <span className="at">{timeAgo(row.at)}</span>
              </div>
            )
          })}
        </div>
      )}

      {feed.data && (
        <div className="feed-foot">
          <div className="status">
            {pausedNow > 0 ? (
              <span>
                <b style={{ color: 'var(--red)' }}>{plural(pausedNow, 'workflow')} paused now</b> ·{' '}
                {plural(rows.length, 'change')} checked
              </span>
            ) : (
              <span>
                {plural(rows.length, 'change')} checked · <b>nothing paused</b>
              </span>
            )}
            <small>
              <Freshness />
            </small>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {API_MODE === 'mock' && (
              <button className="btn ghost small" onClick={resetMock} title="Mock only: restore the seed state">
                Reset mock
              </button>
            )}
            <button className="btn primary wide" onClick={() => navigate('/')}>
              Enter a change
            </button>
          </div>
        </div>
      )}

      {unmatched.length > 0 && (
        <section className="unmatched-list">
          <div className="eyebrow">Unmatched · waiting for a person ({unmatched.length})</div>
          {unmatched.map((u, i) => (
            <div className="unmatched-item" key={`${u.at}-${i}`}>
              <div style={{ flex: 1 }}>
                <div>“{u.raw}”</div>
                <div className="reason">{u.reason}</div>
              </div>
              <button className="btn small" onClick={() => navigate('/', { state: { text: u.raw } })}>
                Map it
              </button>
              <button
                className="btn ghost small"
                onClick={() => {
                  unmatchedQueue.remove(i)
                  setUnmatched(unmatchedQueue.list())
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  )
}
