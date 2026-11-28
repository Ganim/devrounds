import type { ReactNode } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { Ring } from '../primitives/Ring.tsx'
import './StatStrip.css'

export type Stat = {
  key: string
  label: string
  value: ReactNode
  /** Small text after the value: `/ 94 GB`. */
  of?: ReactNode
  /** 0..1 draws a ring before the figure; the tone overrides the accent gradient (warn/danger past a threshold). */
  ring?: { value: number; tone?: Tone }
}

/** A row of figures in one surface (cx-env CPU / RAM / Docker strip, balance totals). Wraps on narrow screens. */
export function StatStrip({ stats, label }: { stats: Stat[]; label: string }) {
  return (
    <section className="dr-stats" aria-label={label}>
      {stats.map((s) => (
        <div key={s.key} className="dr-stats__item">
          {s.ring ? <Ring value={s.ring.value} tone={s.ring.tone} label={s.label} /> : null}
          <div className="dr-stats__text">
            <div className="dr-stats__label">{s.label}</div>
            <div className="dr-stats__value">
              {s.value}
              {s.of ? <small> {s.of}</small> : null}
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}
