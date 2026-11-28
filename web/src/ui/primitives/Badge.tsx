import type { ReactNode } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import './tone.css'
import './Badge.css'

/**
 * A short label in a tinted pill (cx-env `.chip`). `dot` prefixes a status dot; `mono` for figures (ctx %, cost).
 * `notes` are muted words after the badge, the way a run shows its failure class.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  mono = false,
  title,
  notes = [],
  children,
}: {
  tone?: Tone
  dot?: boolean
  mono?: boolean
  title?: string
  notes?: (string | false | null | undefined)[]
  children: ReactNode
}) {
  const shown = notes.filter((note): note is string => Boolean(note))
  const badge = (
    <span className={cx('dr-badge', `dr-tone-${tone}`, mono && 'dr-badge--mono')} title={title}>
      {dot ? <span className="dr-badge__dot" /> : null}
      {children}
    </span>
  )
  if (shown.length === 0) return badge
  return (
    <span className="dr-badge-notes">
      {badge}
      {shown.map((note) => (
        <span key={note} className="dr-badge-notes__note">
          {note}
        </span>
      ))}
    </span>
  )
}
