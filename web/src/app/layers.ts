import { useEffect, useRef } from 'react'

// Esc closes the topmost open layer only (cx-env rule, P5 design §3 call 14): the "More" sheet over a run detail
// closes first, the detail on the next Esc. Layers register in mount order, so the last one is on top.
const open: { current: () => void }[] = []

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || open.length === 0 || e.defaultPrevented) return
  e.preventDefault()
  open[open.length - 1].current()
})

/** Registers an open layer whose Esc runs `onClose`; unregisters on unmount. */
export function useEscapeLayer(onClose: () => void) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    open.push(ref)
    return () => {
      open.splice(open.indexOf(ref), 1)
    }
  }, [])
}
