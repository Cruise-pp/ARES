import { useEffect, useState, useSyncExternalStore } from 'react'

export type MotionPref = 'system' | 'on' | 'off'

const KEY = 'radius.motion'
const listeners = new Set<() => void>()

function systemReduced(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function getMotionPref(): MotionPref {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
  return v === 'on' || v === 'off' ? v : 'system'
}

/** The reveal runs unless the person (or their system, when they have not chosen) asks for reduced motion. */
export function motionReduced(pref = getMotionPref()): boolean {
  return pref === 'off' || (pref === 'system' && systemReduced())
}

function applyRootClass() {
  document.documentElement.classList.toggle('reduce-motion', motionReduced())
}

export function setMotionPref(pref: MotionPref) {
  localStorage.setItem(KEY, pref)
  applyRootClass()
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  applyRootClass()
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    applyRootClass()
    listeners.forEach((l) => l())
  })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useMotionPref(): { pref: MotionPref; reduced: boolean; systemReduced: boolean } {
  const pref = useSyncExternalStore(subscribe, getMotionPref, () => 'system' as MotionPref)
  return { pref, reduced: motionReduced(pref), systemReduced: systemReduced() }
}

export function useReducedMotion(): boolean {
  return useMotionPref().reduced
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
