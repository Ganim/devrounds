import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx.ts'
import './Card.css'

/**
 * A surface with a hairline border (cx-env `.card`). `selected` marks the card whose detail is open. A clickable card
 * is a pattern (ListCard) that puts a real button inside, so a grip or a link in the card never nests in a button.
 */
export function Card({
  selected = false,
  padding = 'md',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { selected?: boolean; padding?: 'none' | 'sm' | 'md'; children: ReactNode }) {
  return (
    <div {...rest} className={cx('dr-card', `dr-card--pad-${padding}`, selected && 'is-selected', className)}>
      {children}
    </div>
  )
}
