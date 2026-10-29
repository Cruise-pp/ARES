// Contract types. The engine is the source of truth (engine/radius/api.py, core.py, pipeline.py).
// 'subagent' and 'DELEGATES' are not in the engine graph. Screens skip them when a graph has none.

export type NodeType = 'tool' | 'data' | 'agent' | 'subagent' | 'workflow' | 'obligation' | 'output'
export type EdgeType = 'RUNS_ON' | 'READS' | 'INVOKES' | 'DELEGATES' | 'SERVES' | 'SENDS'

export type Target = 'tool' | 'data' | 'agent' | 'workflow' | 'obligation'
export type Op = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'prefix'
export type CondValue = string | number | boolean | string[]

export interface Cond {
  field: string
  op: Op
  value: CondValue
}

export type Where = { all: Cond[] } | { any: Cond[] }

export type Kind = 'faulty_tool' | 'personal_data' | 'new_rule' | 'other'

export interface Effect {
  type: 'fault' | 'add_label' | 'rule'
  ref?: string
  fix?: string
  label?: string
}

export interface ChangeEvent {
  id?: string
  kind: Kind
  title?: string
  target: Target
  where: Where
  effect: Effect
  mode?: RunMode
  source?: { lane: 'feed' | 'paste' | 'words'; raw: string }
  parse?: { by: 'model' | 'code' | 'person'; confidence?: number | null; receipt?: string }
}

export interface GraphNode {
  id: string
  type: NodeType
  name?: string
  owner_id?: string
  // tool
  version?: string
  ecosystem?: string
  // data
  table?: string
  column?: string
  labels?: string[]
  // agent
  model_id?: string
  model_region?: string
  // workflow
  sends_external?: boolean
  state?: string
  // obligation
  authority?: string
  // output
  channel?: string
  volume?: number | null
  [extra: string]: unknown
}

/** GET /graph returns `{from, to, type}`. normalizeGraph maps that onto source/target. */
export interface GraphEdge {
  source: string
  target: string
  type: EdgeType
}

export interface Owner {
  id: string
  team: string
  person: string
  channel?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  synced_at: string
  /** Fraction of nodes complete, as GET /graph returns it. 0.94 means 94%. */
  coverage: number
  owners: Owner[]
  unknown_agents: string[]
}

export type MatchState = 'exact' | 'ambiguous' | 'none'

export interface Candidate {
  id: string
  label: string
  score: number
}

export interface ParsedChange {
  change: ChangeEvent
  state: MatchState
  matches: string[]
  candidates: Candidate[]
  readback: string
  reason?: string
}

export type RunMode = 'live' | 'preview'

export interface Counts {
  agents: number
  workflows: number
  paused: number
  warned: number
  duties: number
  outputs: number
  untouched: number
}

export interface Reached {
  id: string
  type: NodeType
  name: string
  hops: number
  path: string[]
  /** The one edge that reached this node. Null on a start node. */
  via: EdgeType | null
}

export interface Verdict {
  workflow_id: string
  risk: 'high' | 'low'
  action: 'paused' | 'warned' | 'none'
}

export interface Run {
  run_id: string
  mode: RunMode
  elapsed_ms: number
  change: ChangeEvent
  counts: Counts
  reached: Reached[]
  verdicts: Verdict[]
  incidents: string[]
  tasks: string[]
}

export interface Incident {
  id: string
  cause: string
  path: string
  risk: string
  duty: string
  action: string
  owner: string
  next: string
  workflow_id?: string
  change_id?: string
  run_id?: string
  state?: string
}

export type TaskState = 'open' | 'accepted' | 'closed'

export interface Task {
  id: string
  owner_id: string
  workflow_id: string
  incident_id: string | null
  message: string
  state: TaskState
}

export interface TaskWithIncident {
  task: Task
  incident: Incident | null
}

export interface FeedRow {
  change_id: string
  title: string
  kind: Kind | string
  /** Engine text, for example "3 agents · 3 workflows". */
  reach: string
  state: string
  at: string
  /**
   * Not a field of GET /changes. The client fills it from a fired GET /record event,
   * or from the run this browser just posted.
   */
  run_id?: string
}

/** One line of GET /record. Append-only: fired, paused, warned, resumed, closed, dispatched. */
export interface RecordEvent {
  at: string
  event: string
  change_id?: string
  run_id?: string
  workflow_id?: string
  incident_id?: string
  task_id?: string
  reason?: string
  title?: string
  by?: string
}
