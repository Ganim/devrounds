import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import './tone.css'
import './Dot.css'

/** A status dot; `live` adds the halo cx-env draws around a working session. */
export function Dot({ tone = 'idle', live = false, label }: { tone?: Tone; live?: boolean; label?: string }) {
  return label ? (
    <span
      className={cx('dr-dot', `dr-tone-${tone}`, live && 'dr-dot--live')}
      role="img"
      aria-label={label}
      title={label}
    />
  ) : (
    <span className={cx('dr-dot', `dr-tone-${tone}`, live && 'dr-dot--live')} aria-hidden="true" />
  )
}
