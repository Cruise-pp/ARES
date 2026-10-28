import type {
  ChangeEvent,
  EdgeType,
  FeedRow,
  Graph,
  GraphEdge,
  GraphNode,
  Incident,
  ParsedChange,
  Run,
  RunMode,
  Task,
  TaskWithIncident,
  Verdict,
} from './types'

export const API_MODE: 'mock' | 'live' = import.meta.env.VITE_API === 'live' ? 'live' : 'mock'
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000'
const MOCK_DELAY_MS = 300

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
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
    try {
      const j = await res.json()
      msg = typeof j.detail === 'string' ? j.detail : (j.message ?? msg)
    } catch {
      /* body is not JSON */
    }
    throw new ApiError(res.status, msg)
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

export function normalizeGraph(raw: Partial<Graph> & { nodes?: (GraphNode & { edges?: unknown })[] }): Graph {
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
  const cov = Number(raw.coverage ?? 0)
  return {
    nodes,
    edges,
    synced_at: raw.synced_at ?? new Date().toISOString(),
    coverage: cov <= 1 ? Math.round(cov * 100) : Math.round(cov),
  }
}

type LooseTask = Partial<TaskWithIncident> & Partial<Task> & { incident?: Incident | null }

export function normalizeTask(raw: LooseTask): TaskWithIncident {
  if (raw.task) return { task: raw.task, incident: raw.incident ?? null }
  const { incident, ...task } = raw
  return { task: task as Task, incident: incident ?? null }
}

// ---------------------------------------------------------------- endpoints

export const api = {
  async getGraph(): Promise<Graph> {
    if (API_MODE === 'mock') return normalizeGraph(await mock((m) => m.mockServer.getGraph()))
    return normalizeGraph(await http('GET', '/graph'))
  },

  parseChange(text: string): Promise<ParsedChange> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.parseChange(text))
    return http('POST', '/changes/parse', { text })
  },

  postChange(change: ChangeEvent, mode: RunMode): Promise<Run> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.postChange(change, mode))
    return http('POST', '/changes', { change, mode })
  },

  getChanges(): Promise<FeedRow[]> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.getChanges())
    return http('GET', '/changes')
  },

  getRun(id: string): Promise<Run> {
    if (API_MODE === 'mock') return mock((m) => m.mockServer.getRun(id))
    return http('GET', `/runs/${encodeURIComponent(id)}`)
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
