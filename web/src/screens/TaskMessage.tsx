import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { TaskWithIncident } from '../api/types'
import { lowerFirst, ownerName } from '../lib/format'

const NEXT_LINE = /^next:\s*/i

function lines(message: string): string[] {
  return message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** The one next step for a task: from its incident, or from a "Next:" line in the message. */
export function nextOf({ task, incident }: TaskWithIncident): string {
  if (incident?.next) return capitalise(incident.next)
  const line = lines(task.message).find((l) => NEXT_LINE.test(l))
  return line ? line.replace(NEXT_LINE, '') : lines(task.message).slice(-1)[0] ?? ''
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function withStop(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`
}

export function TaskMessage() {
  const { taskId = '' } = useParams()
  const { nodes } = useGraph()
  const state = useAsync(() => api.getTask(taskId), [taskId])
  const [showPath, setShowPath] = useState(false)
  const [busy, setBusy] = useState(false)

  if (state.error) {
    return (
      <div className="msg-page">
        <div className="msg">
          <div className="msg-body">
            <h1>This step is not available.</h1>
            <p>{state.error.message}</p>
          </div>
        </div>
      </div>
    )
  }
  if (!state.data) return <div className="msg-page">Loading…</div>

  const { task, incident } = state.data
  const wf = nodes.get(task.workflow_id)
  const wfName = wf?.name ?? task.workflow_id
  const body = lines(task.message)
  const heading = body[0] ?? `Your ${lowerFirst(wfName)} needs one step.`
  const rest = body.slice(1).filter((l) => !NEXT_LINE.test(l))
  const path = incident ? (Array.isArray(incident.path) ? incident.path : incident.path.split(' → ')) : []
  const pathShown = path.length > 1 && ['tool', 'data', 'rule', 'agent', 'workflow'].includes(path[0]) ? path.slice(1) : path
  const time = incident ? (/(\d{1,2}:\d{2})/.exec(incident.action)?.[1] ?? '') : ''

  const accept = async () => {
    setBusy(true)
    try {
      const t = await api.acceptTask(task.id)
      state.setData({ task: t, incident })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="msg-page">
      <article className="msg" aria-label="Message from Radius">
        <header className="msg-head">
          <span className="r">R</span>
          <div>
            <div style={{ fontWeight: 600 }}>Radius</div>
            <div style={{ color: '#6e6e73' }}>
              to {ownerName(task.owner_id)}
              {time && ` · ${time}`}
            </div>
          </div>
        </header>
        <div className="msg-body">
          <h1>{heading}</h1>
          {rest.length > 0 && <p>{rest.join(' ')}</p>}

          {incident && (
            <div className="msg-block">
              <div className="eyebrow">The cause</div>
              <div className="cause">{incident.cause}</div>
              <div className="path">{pathShown.join(' → ')}</div>
              {showPath && (
                <ul className="path-list">
                  {path.map((p, i) => (
                    <li key={`${p}-${i}`}>
                      <span className="verb">{i === 0 ? 'start' : '→'}</span>
                      {p}
                    </li>
                  ))}
                  <li>
                    <span className="verb">duty</span>
                    {incident.duty}
                  </li>
                  <li>
                    <span className="verb">risk</span>
                    {incident.risk}
                  </li>
                </ul>
              )}
            </div>
          )}

          <div className="msg-block next">
            <div className="eyebrow">Your next step</div>
            <div className="step">{withStop(nextOf(state.data))}</div>
            <div className="after">
              {incident
                ? `The ${lowerFirst(wfName)} starts again on its own after the change.`
                : 'Nothing is paused. Radius clears this step when the fix lands.'}
            </div>
          </div>

          {task.state === 'closed' ? (
            <div className="msg-done">Done. Radius saw the fix and closed this step.</div>
          ) : (
            <div className="msg-actions">
              {task.state === 'accepted' ? (
                <span className="btn accepted-pill" role="status">
                  <span className="check">✓</span> You will do this
                </span>
              ) : (
                <button className="btn primary" onClick={accept} disabled={busy}>
                  {busy ? 'Saving…' : 'I will do this'}
                </button>
              )}
              {incident && (
                <button className="btn" onClick={() => setShowPath((s) => !s)}>
                  {showPath ? 'Hide the path' : 'Show the path'}
                </button>
              )}
              <a
                className="btn ghost"
                href={`mailto:ai-platform@example.com?subject=${encodeURIComponent(`${incident?.id ?? task.id} · ${wfName}`)}`}
              >
                Ask a person
              </a>
            </div>
          )}
          {task.state === 'accepted' && (
            <div className="msg-done accepted-note">
              Thanks. Radius will see the new version and close this step on its own.
            </div>
          )}
        </div>
      </article>
    </div>
  )
}
