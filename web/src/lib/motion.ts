import { useEffect, useState } from 'react'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Page 25: counters ease out with 1-(1-t)^3 so the last digits settle instead of snapping. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/**
 * Counts from 0 to `target`, starting `startMs` after `epoch`. When `animate` is false
 * the final value renders at once.
 */
export function useCountUp(target: number, epoch: number | null, startMs: number, durationMs: number, animate: boolean) {
  const [value, setValue] = useState(animate ? 0 : target)
  useEffect(() => {
    if (!animate || epoch === null) {
      setValue(target)
      return
    }
    let raf = 0
    const tick = () => {
      const t = (performance.now() - epoch - startMs) / durationMs
      if (t <= 0) setValue(0)
      else if (t >= 1) {
        setValue(target)
        return
      } else setValue(Math.round(target * easeOutCubic(t)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, epoch, startMs, durationMs, animate])
  return value
}
