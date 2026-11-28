import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import { IconButton } from './IconButton.tsx'
import './tone.css'
import './Toast.css'

export type ToastInput = { text: string; tone?: Tone; action?: { label: string; run: () => void }; ms?: number }
type Shown = ToastInput & { id: number }

const ToastContext = createContext<(toast: ToastInput) => void>(() => {})

/** `useToast()(…)` shows a toast; the app mounts one ToastProvider. Without one the call does nothing. */
export const useToast = () => useContext(ToastContext)

/**
 * Holds the toasts and draws them bottom-centre. The stack is a manual popover so it sits in the top layer, above an
 * open `<dialog>` (cx-env: a fixed element under a modal dialog is painted behind it). A toast leaves after `ms`
 * (5 s; 8 s with an action) or on its close button.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Shown[]>([])
  const next = useRef(0)
  const host = useRef<HTMLDivElement>(null)
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])
  const show = useCallback(
    (toast: ToastInput) => {
      const id = next.current++
      setToasts((all) => [...all.slice(-3), { ...toast, id }])
      setTimeout(() => dismiss(id), toast.ms ?? (toast.action ? 8000 : 5000))
    },
    [dismiss],
  )
  useEffect(() => {
    const el = host.current
    if (!el?.showPopover) return
    // Re-show on every change: opening a dialog later puts it above an older top-layer entry.
    if (el.matches(':popover-open')) el.hidePopover()
    if (toasts.length > 0) el.showPopover()
  }, [toasts])
  const value = useMemo(() => show, [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div ref={host} className="dr-toasts" popover="manual" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('dr-toast', `dr-tone-${t.tone ?? 'neutral'}`)}>
            <span className="dr-toast__bar" aria-hidden="true" />
            <span className="dr-toast__text">{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="dr-toast__action"
                onClick={() => {
                  dismiss(t.id)
                  t.action?.run()
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <IconButton icon="x" label="Dismiss" size="sm" variant="ghost" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
