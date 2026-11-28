import type { ReactNode } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import { Dot } from '../primitives/Dot.tsx'
import '../primitives/tone.css'
import './ListCard.css'

/**
 * A row card as in the cx-env task list: optional grip, a status dot in a square, title, a meta line, something on the
 * right (a percentage, a menu) and an optional progress line along the bottom edge. The body is a link (`href`) or a
 * button (`onOpen`), so the grip and trailing controls are never nested inside it.
 */
export function ListCard({
  title,
  meta,
  status,
  trailing,
  progress,
  selected = false,
  grip,
  href,
  onOpen,
}: {
  title: ReactNode
  meta?: ReactNode
  status?: { tone: Tone; live?: boolean; label: string }
  trailing?: ReactNode
  progress?: { value: number; tone?: Tone }
  selected?: boolean
  grip?: ReactNode
  href?: string
  onOpen?: () => void
}) {
  const body = (
    <>
      {status ? (
        <span className="dr-listcard__status">
          <Dot tone={status.tone} live={status.live} label={status.label} />
        </span>
      ) : null}
      <span className="dr-listcard__text">
        <span className="dr-listcard__title">{title}</span>
        {meta ? <span className="dr-listcard__meta">{meta}</span> : null}
      </span>
    </>
  )
  return (
    <div className={cx('dr-listcard', selected && 'is-selected', progress && 'has-progress')}>
      {grip}
      {href ? (
        <a className="dr-listcard__body" href={href} aria-current={selected || undefined}>
          {body}
        </a>
      ) : onOpen ? (
        <button type="button" className="dr-listcard__body" onClick={onOpen} aria-pressed={selected}>
          {body}
        </button>
      ) : (
        <div className="dr-listcard__body">{body}</div>
      )}
      {trailing ? <div className="dr-listcard__trailing">{trailing}</div> : null}
      {progress ? (
        <span className={cx('dr-listcard__edge', progress.tone && `dr-tone-${progress.tone} is-toned`)}>
          <b style={{ width: `${100 * Math.min(1, Math.max(0, progress.value))}%` }} />
        </span>
      ) : null}
    </div>
  )
}
