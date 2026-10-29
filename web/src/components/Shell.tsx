import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import { coveragePercent, timeAgo } from '../lib/format'
import { setMotionPref, useMotionPref, type MotionPref } from '../lib/motion'

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
      graph synced {timeAgo(graph.synced_at)} · {coveragePercent(graph.coverage)}% coverage
    </span>
  )
}

const MOTION_LABEL: Record<MotionPref, string> = { on: 'On', off: 'Off', system: 'System' }

function Menu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()
  const { pref } = useMotionPref()

  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menu">
        <span />
        <span />
      </button>
      {open && (
        <nav className="menu-pop">
          <NavLink to="/" end>
            New change
          </NavLink>
          <NavLink to="/changes">Recent changes</NavLink>
          <NavLink to="/graph">The whole graph</NavLink>
          <NavLink to="/policy">Policy preview</NavLink>
          <NavLink to="/record">Record</NavLink>
          <div className="menu-sep" />
          <div className="menu-row">
            <span>Motion</span>
            <span className="seg">
              {(['on', 'system', 'off'] as MotionPref[]).map((p) => (
                <button key={p} className={pref === p ? 'on' : ''} onClick={() => setMotionPref(p)}>
                  {MOTION_LABEL[p]}
                </button>
              ))}
            </span>
          </div>
        </nav>
      )}
    </div>
  )
}

export function Shell() {
  const { pathname } = useLocation()
  const theme = DARK_ROUTES.some((r) => r.test(pathname)) ? 'dark' : 'light'

  useEffect(() => {
    document.body.style.background = theme === 'dark' ? '#0a0b0e' : '#f5f5f7'
  }, [theme])

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Radius, new change">
          <span className="brand-dot" />
          Radius
        </Link>
        <div className="topbar-right">
          <Freshness />
          {API_MODE === 'mock' && <span className="mode-pill" title="VITE_API=mock">MOCK</span>}
          <Menu />
        </div>
      </header>
      <Outlet />
    </div>
  )
}
