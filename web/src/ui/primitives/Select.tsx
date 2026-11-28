import type { SelectHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import { Icon } from '../icons.tsx'
import './Select.css'

export type SelectOption = { value: string; label: string }

/** A native select with the panel's look: the OS picker stays (best on phones), only the closed box is styled. */
export function Select({
  options,
  className,
  size = 'md',
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { options: SelectOption[]; size?: 'md' | 'sm' }) {
  return (
    <span className={cx('dr-select', size === 'sm' && 'dr-select--sm', className)}>
      <select {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" />
    </span>
  )
}
