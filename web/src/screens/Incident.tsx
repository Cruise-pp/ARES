import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import { motionReduced } from '../lib/motion'
import type { Incident, TaskWithIncident } from '../api/types'
import { Freshness } from '../components/Shell'
import { ownerName, plural } from '../lib/format'
import { nextOf } from './TaskMessage'

export function pathText(path: Incident['path']): string {
  return Array.isArray(path) ? path.join(' → ') : path
}

function openedAt(incident: Incident): string {
  const m = /(\d{1,2}:\d{2})(:\d{2})?/.exec(incident.action)
  return m ? m[1] : ''
}

export function SevenLines({ incident }: { incident: Incident }) {
  return (
    <dl className="seven">
      <dt>cause</dt>
      <dd className="red">{incident.cause}</dd>
      <dt>path</dt>
      <dd>{pathText(incident.path).replace(/ → /g, ' → \n')}</dd>
      <dt>risk</dt>
      <dd className="red">{incident.risk}</dd>
      <dt>duty</dt>
      <dd className="blue">{incident.duty}</dd>
      <dt>action</dt>
      <dd>{incident.action}</dd>
      <dt>owner</dt>
      <dd>{incident.owner}</dd>
      <dt>next</dt>
      <dd className="blue">{incident.next}</dd>
    </dl>
  )
}

export function IncidentScreen() {
  const { runId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { nodes, refresh } = useGraph()
  const runState = useAsync(() => api.getRun(runId), [runId])
  const run = runState.data
  const [items, setItems] = useState<TaskWithIncident[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!run) return
    let live = true
    Promise.all(run.tasks.map((id) => api.getTask(id))).then(
      (r) => live && setItems(r),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [run, tick])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  if (runState.error) return <main className="page"><div className="error-box">{runState.error.message}</div></main>
  if (!run || !items) return <div className="loading">{error ?? 'Loading the incident…'}</div>

  const verdictOf = new Map(run.verdicts.map((v) => [v.workflow_id, v]))
  const withIncident = items.filter((i) => i.incident)
  const selectedTaskId = params.get('task')
  const selected =
    withIncident.find((i) => i.task.id === selectedTaskId) ??
    withIncident.find((i) => i.task.state !== 'closed') ??
    withIncident[0]
  const queue = items.filter((i) => i.task.state !== 'closed')
  const incident = selected?.incident ?? null
  const closed = selected?.task.state === 'closed'
  const wfName = (id: string) => nodes.get(id)?.name ?? id

  const start = run.reached.find((r) => r.hops === 0)
  const fix = run.change.effect.fix
  const canLandFix = run.mode === 'live' && run.change.target === 'tool' && !!fix && !!start && queue.length > 0

  const landFix = async () => {
    if (!start || !fix) return
    setFixing(true)
    try {
      await api.setToolVersion(start.id, fix)
      // Let each open step visibly close before the list redraws empty.
      setClosing(true)
      await new Promise((r) => setTimeout(r, motionReduced() ? 0 : 520 + 90 * (items?.length ?? 0)))
      refresh()
      setTick((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFixing(false)
      setClosing(false)
    }
  }

  return (
    <>
      <div className="br-head">
        <Link to={`/runs/${encodeURIComponent(run.run_id)}`} className="back">
          ← Blast radius
        </Link>
        {incident ? (
          <>
            <span className="cid">{incident.id}</span>
            <span className={`badge ${closed ? 'ok' : 'contained'}`}>{closed ? 'RESOLVED' : 'CONTAINED'}</span>
          </>
        ) : (
          <span className="cid">{run.change.title}</span>
        )}
        <div className="right">
          {incident && <div>opened {openedAt(incident)} · by Radius, not a person</div>}
          <Freshness />
        </div>
      </div>

      <div className="inc">
        <section className="inc-col">
          <div className="eyebrow">The incident</div>
          {incident ? (
            <>
              <SevenLines incident={incident} />
              <div style={{ display: 'flex', gap: 8 }}>
                <Link
                  className="btn"
                  to={`/runs/${encodeURIComponent(run.run_id)}?focus=${encodeURIComponent(selected!.task.workflow_id)}`}
                >
                  Open the path
                </Link>
                <Link className="btn ghost" to={`/task/${encodeURIComponent(selected!.task.id)}`}>
                  Owner message ↗
                </Link>
              </div>
              {withIncident.length > 1 && (
                <div style={{ marginTop: 22 }}>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>
                    {plural(withIncident.length, 'incident')} from this change
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {withIncident.map((i) => (
                      <button
                        key={i.incident!.id}
                        className={`btn small ${i === selected ? 'primary' : ''}`}
                        onClick={() => setParams({ task: i.task.id }, { replace: true })}
                      >
                        {i.incident!.id} · {wfName(i.task.workflow_id)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="muted">
              {run.mode === 'preview' ? 'A preview opens no incident.' : 'Nothing was paused, so no incident was opened.'}
            </p>
          )}
        </section>

        <section className="inc-col">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
            <span className="eyebrow">Owner queue</span>
            <span className="faint" style={{ fontSize: 12 }}>
              {queue.length} open · 0 overdue
            </span>
          </div>

          {queue.length === 0 && (
            <div className="queue-empty">
              <span className="check">✓</span>
              The queue is empty. Every owner step is done.
            </div>
          )}

          {queue.map((i, idx) => {
            const warned = verdictOf.get(i.task.workflow_id)?.action === 'warned'
            const state = i.task.state === 'accepted' ? 'accepted' : warned ? 'warned' : 'open'
            return (
              <div
                key={i.task.id}
                role="button"
                tabIndex={0}
                className={`queue-row ${state} ${i === selected ? 'on' : ''} ${closing ? 'closing' : ''}`}
                style={closing ? { animationDelay: `${idx * 90}ms` } : undefined}
                onClick={() => i.incident && setParams({ task: i.task.id }, { replace: true })}
              >
                <div className="top">
                  <span className="owner">{ownerName(i.task.owner_id)}</span>
                  <span className={`badge ${state === 'open' ? 'open' : state}`} style={{ minWidth: 64 }}>
                    {closing ? '✓ DONE' : state.toUpperCase()}
                  </span>
                </div>
                <div className="wf">{wfName(i.task.workflow_id)}</div>
                <div className="next">→ {nextOf(i)}</div>
                <Link to={`/task/${encodeURIComponent(i.task.id)}`} onClick={(e) => e.stopPropagation()}>
                  message
                </Link>
              </div>
            )
          })}

          {canLandFix && (
            <div className="demo-bar" style={{ marginTop: 18 }}>
              <span style={{ flex: 1 }}>
                Demo · the fix lands: {start!.name.split(' ')[0]} → {fix}
              </span>
              <button className="btn small" onClick={landFix} disabled={fixing}>
                {fixing ? 'Landing…' : 'Land the fix'}
              </button>
            </div>
          )}
          {error && <div className="error-box" style={{ marginTop: 12 }}>{error}</div>}
        </section>
      </div>
    </>
  )
}
