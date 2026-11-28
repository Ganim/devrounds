import { type ReactNode, useCallback, useRef } from 'react'
import { cx } from '../cx.ts'
import { useDismiss } from './layers.ts'
import './Popover.css'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/**
 * A floating panel anchored to `anchor` (cx-env `.qpop`). The caller owns `open` and renders the trigger in `anchor`;
 * Esc and a press outside call `onClose`. Positioned by CSS against the wrapper, so it needs no measuring.
 */
export function Popover({
  open,
  onClose,
  anchor,
  placement = 'bottom-start',
  label,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  anchor: ReactNode
  placement?: Placement
  label?: string
  className?: string
  children: ReactNode
}) {
  const root = useRef<HTMLSpanElement>(null)
  useDismiss(
    open,
    onClose,
    useCallback(() => root.current, []),
  )
  return (
    <span ref={root} className="dr-popover-anchor">
      {anchor}
      {open ? (
        <div className={cx('dr-popover', `dr-popover--${placement}`, className)} role="dialog" aria-label={label}>
          {children}
        </div>
      ) : null}
    </span>
  )
}
