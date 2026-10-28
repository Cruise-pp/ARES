// Browser-only lists for things page 31d has no endpoint for: the Unmatched queue
// and the resume reasons this browser wrote. Both are reported as contract gaps.

export interface UnmatchedItem {
  raw: string
  reason: string
  at: string
}

export interface ResumeEntry {
  workflow_id: string
  name: string
  reason: string
  run_id: string
  at: string
}

const UNMATCHED = 'radius.unmatched'
const RESUMES = 'radius.resumes'

function read<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as T[]
  } catch {
    return []
  }
}

function write<T>(key: string, items: T[]) {
  localStorage.setItem(key, JSON.stringify(items))
}

export const unmatchedQueue = {
  list: () => read<UnmatchedItem>(UNMATCHED),
  add: (item: UnmatchedItem) => write(UNMATCHED, [item, ...read<UnmatchedItem>(UNMATCHED)]),
  remove: (index: number) => write(UNMATCHED, read<UnmatchedItem>(UNMATCHED).filter((_, i) => i !== index)),
}

export const resumeLog = {
  list: () => read<ResumeEntry>(RESUMES),
  add: (entry: ResumeEntry) => write(RESUMES, [entry, ...read<ResumeEntry>(RESUMES)]),
}

export function clearLocal() {
  localStorage.removeItem(UNMATCHED)
  localStorage.removeItem(RESUMES)
}
