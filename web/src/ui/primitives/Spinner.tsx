import { cx } from '../cx.ts'
import './Spinner.css'

/** A loading ring; `label` is read by screen readers (and shown when `showLabel`). */
export function Spinner({
  label = 'Loading',
  showLabel = false,
  size = 'md',
}: {
  label?: string
  showLabel?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <span className="dr-spinner-wrap" role="status">
      <span className={cx('dr-spinner', size === 'sm' && 'dr-spinner--sm')} aria-hidden="true" />
      <span className={showLabel ? 'dr-spinner__label' : 'dr-sr-only'}>{label}</span>
    </span>
  )
}
