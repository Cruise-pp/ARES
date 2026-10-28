import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './client'
import type { Graph, GraphNode } from './types'

export interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => void
  setData: (d: T | null) => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    fnRef.current().then(
      (d) => {
        if (!live) return
        setData(d)
        setLoading(false)
      },
      (e: Error) => {
        if (!live) return
        setError(e)
        setLoading(false)
      },
    )
    return () => {
      live = false
    }
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload, setData }
}

interface GraphCtx {
  graph: Graph | null
  error: Error | null
  nodes: Map<string, GraphNode>
  refresh: () => void
}

const Ctx = createContext<GraphCtx>({ graph: null, error: null, nodes: new Map(), refresh: () => {} })

export function GraphProvider({ children }: { children: ReactNode }) {
  const { data, error, reload } = useAsync(() => api.getGraph(), [])
  const nodes = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data])
  const value = useMemo(() => ({ graph: data, error, nodes, refresh: reload }), [data, error, nodes, reload])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useGraph = () => useContext(Ctx)
