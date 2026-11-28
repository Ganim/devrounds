import { useEffect } from 'react'

// Open popovers and menus, oldest first. Esc closes only the last one (cx-env: Esc closes the topmost layer); native
// dialogs handle their own Esc, and the capture listener below stops the key before a dialog under the popover sees it.
const stack: symbol[] = []

/** While `open`, Esc and a pointer press outside `inside()` call `onClose`, only for the topmost open layer. */
export function useDismiss(open: boolean, onClose: () => void, inside: () => HTMLElement | null) {
  useEffect(() => {
    if (!open) return
    const me = Symbol('layer')
    stack.push(me)
    const top = () => stack[stack.length - 1] === me
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !top()) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const onPointer = (event: PointerEvent) => {
      const root = inside()
      if (top() && root && !root.contains(event.target as Node)) onClose()
    }
    addEventListener('keydown', onKey, true)
    addEventListener('pointerdown', onPointer, true)
    return () => {
      stack.splice(stack.indexOf(me), 1)
      removeEventListener('keydown', onKey, true)
      removeEventListener('pointerdown', onPointer, true)
    }
  }, [open, onClose, inside])
}
