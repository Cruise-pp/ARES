import { EASE } from './motion'

/**
 * The shared-element hand-off from the box to the blast radius.
 * Plain DOM and the Web Animations API, because it has to outlive the route change:
 * the orb leaves the Fire button on one page and lands on the change node on the next.
 */

interface Flight {
  orb: HTMLDivElement
  trail: HTMLDivElement[]
  curtain: HTMLDivElement
  covered: Promise<void>
  anims: Animation[]
  safety: number
  landing?: Promise<void>
}

let flight: Flight | null = null

const el = (cls: string) => {
  const d = document.createElement('div')
  d.className = cls
  document.body.appendChild(d)
  return d
}

function cleanup() {
  if (!flight) return
  const f = flight
  flight = null
  clearTimeout(f.safety)
  f.anims.forEach((a) => a.cancel())
  ;[f.orb, ...f.trail, f.curtain].forEach((d) => d.remove())
}

/** Starts the flight at `from`. Resolves `covered` when the dark curtain fills the screen. */
export function launch(from: DOMRect): Promise<void> {
  cleanup()
  const x = from.left + from.width / 2
  const y = from.top + from.height / 2
  const curtain = el('handoff-curtain')
  const trail = [0, 1, 2].map((i) => {
    const t = el('handoff-orb trail')
    t.style.opacity = String(0.5 - i * 0.14)
    return t
  })
  const orb = el('handoff-orb')
  for (const d of [orb, ...trail]) d.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`
  curtain.style.left = `${x}px`
  curtain.style.top = `${y}px`

  const anims: Animation[] = [
    orb.animate(
      [
        { transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(0.2)`, opacity: 0 },
        { transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(1.5)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(1)`, opacity: 1 },
      ],
      { duration: 380, easing: EASE.out, fill: 'forwards' },
    ),
    ...trail.map((t) => t.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 380, fill: 'forwards' })),
  ]
  const grow = curtain.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0)', opacity: 1 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
    ],
    { duration: 540, delay: 90, easing: EASE.inOut, fill: 'forwards' },
  )
  anims.push(grow)
  const covered = grow.finished.then(() => undefined).catch(() => undefined)
  // If nothing lands (an error, a slow server), never leave the screen dark.
  const safety = window.setTimeout(() => abort(), 6000)
  flight = { orb, trail, curtain, covered, anims, safety }
  return covered
}

export function inFlight(): boolean {
  return flight !== null
}

/**
 * Flies the orb to the change node at (x, y) while the curtain lifts.
 * Resolves at impact, which is t = 0 of the page 25 reveal.
 */
export function land(x: number, y: number): Promise<void> {
  const f = flight
  if (!f) return Promise.resolve()
  // StrictMode runs effects twice; both callers share one landing.
  f.landing ??= fly(f, x, y)
  return f.landing
}

async function fly(f: Flight, x: number, y: number): Promise<void> {
  await f.covered
  if (flight !== f) return
  clearTimeout(f.safety)
  const box = f.orb.getBoundingClientRect()
  const sx = box.left + box.width / 2
  const sy = box.top + box.height / 2
  const at = (px: number, py: number, s: number) => `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${s})`
  const mx = (sx + x) / 2
  const my = Math.min(sy, y) - 60
  const path = [
    { transform: at(sx, sy, 1), offset: 0 },
    { transform: at(mx, my, 1.35), offset: 0.5 },
    { transform: at(x, y, 1.1), offset: 1 },
  ]
  const FLY = 540
  const travel = f.orb.animate(path, { duration: FLY, easing: EASE.out, fill: 'forwards' })
  f.anims.push(travel)
  f.trail.forEach((t, i) => {
    f.anims.push(
      t.animate(
        path.map((k) => ({ ...k, opacity: 0.5 - i * 0.14 })),
        { duration: FLY, delay: 45 * (i + 1), easing: EASE.out, fill: 'forwards' },
      ),
    )
  })
  f.anims.push(f.curtain.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 560, delay: 120, easing: EASE.std, fill: 'forwards' }))
  try {
    await travel.finished
  } catch {
    return
  }
  if (flight !== f) return
  const pop = f.orb.animate(
    [
      { transform: at(x, y, 1.1), opacity: 1 },
      { transform: at(x, y, 3.2), opacity: 0 },
    ],
    { duration: 320, easing: EASE.out, fill: 'forwards' },
  )
  f.anims.push(pop)
  f.trail.forEach((t) => t.animate([{ opacity: 0 }], { duration: 120, fill: 'forwards' }))
  pop.finished.then(() => flight === f && cleanup(), () => undefined)
}

/** Lifts the curtain without a landing, for errors and navigation away. */
export function abort() {
  const f = flight
  if (!f) return
  const out = f.curtain.animate([{ opacity: 0 }], { duration: 260, fill: 'forwards' })
  f.orb.animate([{ opacity: 0 }], { duration: 200, fill: 'forwards' })
  f.trail.forEach((t) => t.animate([{ opacity: 0 }], { duration: 200, fill: 'forwards' }))
  out.finished.then(() => flight === f && cleanup(), () => undefined)
}
