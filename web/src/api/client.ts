import type {
  ChangeEvent,
  EdgeType,
  FeedRow,
  Graph,
  GraphEdge,
  GraphNode,
  Incident,
  Owner,
  ParsedChange,
  RecordEvent,
  Run,
  RunMode,
  Task,
  TaskWithIncident,
  Verdict,
} from './types'

/** Live unless VITE_API=mock. The engine on :8000 is the system of record. */
export const API_MODE: 'mock' | 'live' = import.meta.env.VITE_API === 'mock' ? 'mock' : 'live'
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'
const MOCK_DELAY_MS = 300

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message)
  }
}

function isParsed(body: unknown): body is ParsedChange {
  return !!body && typeof body === 'object' && 'state' in body && 'change' in body
}

async function http<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, `The engine does not answer at ${BASE}.`)
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    let parsed: unknown
    try {
      parsed = await res.json()
      const j = parsed as { detail?: unknown; message?: string; reason?: string; readback?: string }
      if (res.status === 409 && isParsed(parsed)) msg = parsed.reason || parsed.readback || 'This change is not an exact match.'
      else if (typeof j.detail === 'string') msg = j.detail
      else if (j.message) msg = j.message
    } catch {
      /* body is not JSON */
    }
    throw new ApiError(res.status, msg, parsed)
  }
  return (await res.json()) as T
}

async function mock<T>(fn: (m: typeof import('../mocks/server')) => T): Promise<T> {
  const m = await import('../mocks/server')
  await new Promise((r) => setTimeout(r, MOCK_DELAY_MS))
  try {
    return fn(m)
  } catch (e) {
    if (e instanceof m.MockError) throw new ApiError(e.status, e.message)
    throw e
  }
}

// ---------------------------------------------------------------- normalisers

const EDGE_TYPES: EdgeType[] = ['RUNS_ON', 'READS', 'INVOKES', 'DELEGATES', 'SERVES', 'SENDS']

type LooseEdge = Partial<GraphEdge> & { from?: string; to?: string; src?: string; dst?: string }

export function normalizeGraph(
  raw: Partial<Graph> & { nodes?: (GraphNode & { edges?: unknown })[]; owners?: Owner[]; unknown_agents?: string[] },
): Graph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const n of raw.nodes ?? []) {
    const { edges: embedded, ...rest } = n
    nodes.push(rest as GraphNode)
    if (Array.isArray(embedded)) {
      for (const e of embedded as Record<string, string>[]) {
        for (const t of EDGE_TYPES) if (e[t]) edges.push({ source: n.id, target: e[t], type: t })
      }
    }
  }
  for (const e of (raw.edges ?? []) as LooseEdge[]) {
    const source = e.source ?? e.from ?? e.src
    const target = e.target ?? e.to ?? e.dst
    if (source && target && e.type) edges.push({ source, target, type: e.type })
  }
  return {
    nodes,
    edges,
    synced_at: raw.synced_at ?? new Date().toISOString(),
    coverage: Number(raw.coverage ?? 0),
    owners: raw.owners ?? [],
    unknown_agents: raw.unknown_agents ?? [],
  }
}

/** Engine `via` is one edge, or null. Older fixtures stored the whole path as a list. */
export function normalizeVia(via: unknown): EdgeType | null {
  if (via == null || via === '') return null
  if (Array.isArray(via)) {
    const last = via[via.length - 1]
    return typeof last === 'string' ? (last as EdgeType) : null
  }
  return typeof via === 'string' ? (via as EdgeType) : null
}

export function normalizeRun(run: Run): Run {
  return { ...run, reached: run.reached.map((r) => ({ ...r, via: normalizeVia(r.via) })) }
}

const LINK_KEY = 'radius.runLinks'

function loadLinks(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(LINK_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberRun(changeId: string | undefined, runId: string) {
  if (!changeId) return
  try {
    const links = loadLinks()
    links[changeId] = runId
    sessionStorage.setItem(LINK_KEY, JSON.stringify(links))
  } catch {
    /* sessionStorage is unavailable */
  }
}

function normalizeFeedRow(row: FeedRow, runId?: string): FeedRow {
  return { ...row, run_id: runId ?? row.run_id }
}

type LooseTask = Partial<TaskWithIncident> & Partial<Task> & { incident?: Incident | null }

export function normalizeTask(raw: LooseTask): TaskWithIncident {
  if (raw.task) return { task: raw.task, incident: raw.incident ?? null }
  const { incident, ...task } = raw
  return { task: task as Task, incident: incident ?? null }
}

// ---------------------------------------------------------------- endpoints

/** Runs seen this session, so the next screen can paint at once instead of showing a loading frame. */
export const runCache = new Map<string, Run>()

export const api = {
  async getGraph(): Promise<Graph> {
    if (API_MODE === 'mock') return normalizeGraph(await mock((m) => m.mockServer.getGraph()))
    return normalizeGraph(await http('GET', '/graph'))
  },

  parseChange(text: string): Promise<ParsedChange> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.parseChange(text))
    return http('POST', '/changes/parse', { text })
  },

  async postChange(change: ChangeEvent, mode: RunMode): Promise<Run> {
    const raw: Run =
      API_MODE === 'mock' ? await mock((m) => m.mockServer.postChange(change, mode)) : await http('POST', '/changes', { change, mode })
    const run = normalizeRun(raw)
    rememberRun(run.change.id, run.run_id)
    runCache.set(run.run_id, run)
    return run
  },

  async getChanges(): Promise<FeedRow[]> {
    if (API_MODE === 'mock') {
      const rows = await mock((m) => m.mockServer.getChanges())
      return rows.map((row) => normalizeFeedRow(row))
    }
    const [rows, record] = await Promise.all([
      http<FeedRow[]>('GET', '/changes'),
      http<RecordEvent[]>('GET', '/record').catch(() => [] as RecordEvent[]),
    ])
    const fromRecord = new Map<string, string>()
    for (const event of record) {
      if (event.change_id && event.run_id) fromRecord.set(event.change_id, event.run_id)
    }
    const remembered = loadLinks()
    return rows.map((row) => normalizeFeedRow(row, fromRecord.get(row.change_id) ?? remembered[row.change_id]))
  },

  getRecord(): Promise<RecordEvent[]> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.getRecord())
    return http('GET', '/record')
  },

  async getRun(id: string): Promise<Run> {
    const raw: Run = API_MODE === 'mock' ? await mock((m) => m.mockServer.getRun(id)) : await http('GET', `/runs/${encodeURIComponent(id)}`)
    const run = normalizeRun(raw)
    runCache.set(run.run_id, run)
    return run
  },

  resumeWorkflow(id: string, reason: string): Promise<Verdict> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.resumeWorkflow(id, reason))
    return http('POST', `/workflows/${encodeURIComponent(id)}/resume`, { reason })
  },

  async getTask(id: string): Promise<TaskWithIncident> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.getTask(id))
    return normalizeTask(await http('GET', `/tasks/${encodeURIComponent(id)}`))
  },

  acceptTask(id: string): Promise<Task> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.acceptTask(id))
    return http('POST', `/tasks/${encodeURIComponent(id)}/accept`)
  },

  setToolVersion(id: string, version: string): Promise<Verdict[]> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.setToolVersion(id, version))
    return http('POST', `/tools/${encodeURIComponent(id)}/version`, { version })
  },
}
