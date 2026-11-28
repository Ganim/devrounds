import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import './tone.css'
import './ProgressBar.css'

export type BarSegment = { key: string; value: number; tone: Tone; title?: string }

/**
 * A thin bar. `value` (0..1) draws one fill: no tone = progress, always blue to cyan ("how far along"; cx-env keeps
 * ok/warn/danger for resources). `segments` draws a stacked bar instead, each width proportional to its value.
 */
export function ProgressBar({
  value = 0,
  tone,
  segments,
  label,
  size = 'md',
}: {
  value?: number
  tone?: Tone
  segments?: BarSegment[]
  label: string
  size?: 'sm' | 'md'
}) {
  const className = cx('dr-bar', size === 'sm' && 'dr-bar--sm')
  if (segments) {
    const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
    return (
      <div className={className} role="img" aria-label={label}>
        {segments.map((s) =>
          s.value > 0 ? (
            <span
              key={s.key}
              className={`dr-bar__fill dr-bar__fill--toned dr-tone-${s.tone}`}
              style={{ width: `${(100 * s.value) / total}%` }}
              title={s.title}
            />
          ) : null,
        )}
      </div>
    )
  }
  const v = Math.min(1, Math.max(0, value))
  return (
    <div
      className={className}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <span
        className={cx('dr-bar__fill', tone && `dr-bar__fill--toned dr-tone-${tone}`)}
        style={{ width: `${100 * v}%` }}
      />
    </div>
  )
}
