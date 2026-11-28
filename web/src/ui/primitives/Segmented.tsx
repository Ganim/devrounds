import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import './Segmented.css'

export type SegmentedOption<V extends string> = { value: V; label: ReactNode; count?: number }

/** Mutually exclusive filter tabs (cx-env `.seg`: all / active / offline). Each option is a pressed-state button. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  label: string
}) {
  return (
    // biome a11y wants a fieldset for role=group; a fieldset's border and legend fight this layout, so a div keeps it.
    <div className="dr-seg" role="toolbar" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cx(o.value === value && 'is-on')}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="dr-seg__count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
