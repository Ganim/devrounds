import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons.tsx'
import './EmptyState.css'

/** A dashed box saying a list is empty and, when there is one, what to do about it (cx-env `.empty`). */
export function EmptyState({
  title,
  icon = 'inbox',
  action,
  children,
}: {
  title: string
  icon?: IconName
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="dr-empty">
      <Icon name={icon} />
      <div className="dr-empty__title">{title}</div>
      {children ? <div className="dr-empty__text">{children}</div> : null}
      {action ? <div className="dr-empty__action">{action}</div> : null}
    </div>
  )
}
