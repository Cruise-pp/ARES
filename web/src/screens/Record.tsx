import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { FeedRow, Run, TaskWithIncident } from '../api/types'
import { clockTime, kindLabel, nodeLabel, plural, splitTitle, timeAgo } from '../lib/format'
import { resumeLog } from '../lib/local'
import { ACTION_HOPS } from '../lib/reach'

interface Entry {
  row: FeedRow
  run: Run | null
  tasks: TaskWithIncident[]
}

async function loadRecord(): Promise<Entry[]> {
  const rows = await api.getChanges()
  return Promise.all(
    rows.map(async (row) => {
      const run = row.run_id ? await api.getRun(row.run_id).catch(() => null) : null
      const tasks = run ? await Promise.all(run.tasks.map((t) => api.getTask(t).catch(() => null))) : []
      return { row, run, tasks: tasks.filter((t): t is TaskWithIncident => !!t) }
    }),
  )
}

export function Record() {
  const { nodes } = useGraph()
  const state = useAsync(loadRecord, [])
  const resumes = resumeLog.list()

  if (state.error) return <main className="page"><div className="error-box">{state.error.message}</div></main>
  if (!state.data) return <div className="loading">Loading the record…</div>

  const entries = state.data
  const live = entries.filter((e) => e.run?.mode === 'live')

  const duties = new Map<string, { name: string; changes: Set<string>; workflows: Set<string> }>()
  for (const e of live) {
    for (const r of e.run!.reached) {
      if (r.type !== 'obligation' || r.hops > ACTION_HOPS) continue
      const d = duties.get(r.id) ?? { name: nodeLabel(nodes.get(r.id), r.name), changes: new Set(), workflows: new Set() }
      d.changes.add(splitTitle(e.row.title)[0])
      const wf = r.path[r.path.length - 2]
      d.workflows.add(nodes.get(wf)?.name ?? wf)
      duties.set(r.id, d)
    }
  }

  const exportRecord = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            exported_at: new Date().toISOString(),
            changes: entries.map((e) => ({
              feed: e.row,
              run: e.run,
              incidents: e.tasks.map((t) => t.incident).filter(Boolean),
              tasks: e.tasks.map((t) => t.task),
            })),
            resumes,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `radius-record-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <main className="page">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          Record
        </h1>
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={exportRecord}>
          Export the record
        </button>
      </div>

      <div className="record-grid">
        <aside>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Obligations exposed ({duties.size})
          </div>
          {duties.size === 0 && <div className="muted">No obligation was exposed.</div>}
          {[...duties.entries()].map(([id, d]) => (
            <div className="duty-card" key={id}>
              <div className="name">{d.name}</div>
              <div className="why">
                by {[...d.changes].join(', ')} · through {[...d.workflows].join(', ')}
              </div>
            </div>
          ))}

          {resumes.length > 0 && (
            <>
              <div className="eyebrow" style={{ margin: '22px 0 6px' }}>
                Resumed by hand
              </div>
              {resumes.map((r, i) => (
                <div className="log-line" key={`${r.at}-${i}`}>
                  <b>{r.name}</b> · {clockTime(r.at)}
                  <div className="muted">“{r.reason}”</div>
                </div>
              ))}
            </>
          )}
        </aside>

        <section>
          {entries.map(({ row, run, tasks }) => {
            const [main, sub] = splitTitle(row.title)
            const taskFor = new Map(tasks.map((t) => [t.task.workflow_id, t]))
            return (
              <div className="card record-run" key={`${row.change_id}-${row.at}`}>
                <div className="head">
                  <b>{main}</b>
                  <span className="muted">{sub}</span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {kindLabel(row.kind)} · {timeAgo(row.at)}
                  </span>
                  <span style={{ marginLeft: 'auto' }} className="badge none">
                    {row.state}
                  </span>
                </div>
                {!run ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    The run for this change is not available.
                  </div>
                ) : run.verdicts.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    No workflow reached. Recorded as no impact.
                  </div>
                ) : (
                  <table>
                    <tbody>
                      {run.verdicts.map((v) => {
                        const t = taskFor.get(v.workflow_id)
                        return (
                          <tr key={v.workflow_id}>
                            <td>{nodes.get(v.workflow_id)?.name ?? v.workflow_id}</td>
                            <td className="muted">
                              {v.risk} · {run.mode === 'preview' ? 'preview only' : v.action}
                            </td>
                            <td className="mono">{t?.incident?.id ?? ''}</td>
                            <td className="muted">{t ? `step ${t.task.state}` : ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {run && (
                  <div style={{ marginTop: 10, fontSize: 12 }}>
                    <Link to={`/runs/${encodeURIComponent(run.run_id)}`} style={{ color: 'var(--blue)' }}>
                      Blast radius
                    </Link>
                    {run.incidents.length > 0 && (
                      <>
                        {' · '}
                        <Link to={`/runs/${encodeURIComponent(run.run_id)}/incident`} style={{ color: 'var(--blue)' }}>
                          {plural(run.incidents.length, 'incident')}
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </section>
      </div>
    </main>
  )
}
