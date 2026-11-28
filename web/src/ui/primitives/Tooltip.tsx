import { type ReactNode, useId } from 'react'
import { cx } from '../cx.ts'
import './Tooltip.css'

/**
 * A short hint over `children` on hover and on keyboard focus, pure CSS. For an icon-only button prefer its `title`
 * (IconButton sets it); this is for figures and truncated text that need a styled hint.
 */
export function Tooltip({
  text,
  placement = 'top',
  children,
}: {
  text: string
  placement?: 'top' | 'bottom'
  children: ReactNode
}) {
  const id = useId()
  return (
    <span className={cx('dr-tooltip', `dr-tooltip--${placement}`)} aria-describedby={id}>
      {children}
      <span id={id} role="tooltip" className="dr-tooltip__bubble">
        {text}
      </span>
    </span>
  )
}
