import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import { timeAgo } from '../lib/format'
import { useEffect, useState } from 'react'

const DARK_ROUTES = [/^\/runs\//, /^\/graph/]

export function Freshness() {
  const { graph, error } = useGraph()
  const [, setNow] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  if (error) return <span className="freshness down">graph unreachable · {error.message}</span>
  if (!graph) return <span className="freshness">graph loading…</span>
  const ageMin = (Date.now() - Date.parse(graph.synced_at)) / 60_000
  return (
    <span className={`freshness${ageMin > 60 ? ' stale' : ''}`} title={graph.synced_at}>
      graph synced {timeAgo(graph.synced_at)} · {graph.coverage}% coverage
    </span>
  )
}

export function Shell() {
  const { pathname } = useLocation()
  const theme = DARK_ROUTES.some((r) => r.test(pathname)) ? 'dark' : 'light'

  useEffect(() => {
    document.body.style.background = theme === 'dark' ? '#0a0b0e' : '#f5f5f7'
  }, [theme])

  const changesActive = pathname === '/' || pathname.startsWith('/enter') || pathname.startsWith('/runs')

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Radius home">
          <span className="brand-dot" />
          Radius
        </NavLink>
        <nav className="nav">
          <NavLink to="/" className={changesActive ? 'active' : ''} end>
            Changes
          </NavLink>
          <NavLink to="/graph">Graph</NavLink>
          <NavLink to="/policy">Policy</NavLink>
          <NavLink to="/record">Record</NavLink>
        </nav>
        <div className="topbar-right">
          <Freshness />
          {API_MODE === 'mock' && <span className="mode-pill" title="VITE_API=mock">MOCK</span>}
          <span className="avatar" title="Dani Alvarez">DA</span>
        </div>
      </header>
      <Outlet />
    </div>
  )
}
