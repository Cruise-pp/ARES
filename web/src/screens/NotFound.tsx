import { Link } from 'react-router-dom'

export function NotFound() {
  return (
    <main className="page">
      <h1 className="page-title">Nothing here.</h1>
      <p>
        <Link to="/" style={{ color: 'var(--blue)' }}>
          ← Changes
        </Link>
      </p>
    </main>
  )
}
