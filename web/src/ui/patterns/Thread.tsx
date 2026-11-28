import { type ReactNode, useEffect, useRef } from 'react'
import { cx } from '../cx.ts'
import './Thread.css'

/**
 * A conversation column. It stays pinned to the newest message while the reader is at the bottom, and leaves the
 * scroll alone once they scrolled up to read (cx-env thread). `children` are Bubbles, oldest first.
 */
export function Thread({ label, children, empty }: { label: string; children: ReactNode; empty?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return (
    <section
      ref={box}
      className="dr-thread"
      aria-label={label}
      onScroll={(event) => {
        const el = event.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
      }}
    >
      {hasChildren ? children : <div className="dr-thread__empty">{empty}</div>}
    </section>
  )
}

/**
 * One message. `from`: `me` (right, the sent tint), `them` (left), `system` (centred, muted). `pending` marks an
 * optimistic bubble not yet confirmed by the server, `failed` one the server refused.
 */
export function Bubble({
  from,
  meta,
  pending = false,
  failed = false,
  children,
}: {
  from: 'me' | 'them' | 'system'
  meta?: ReactNode
  pending?: boolean
  failed?: boolean
  children: ReactNode
}) {
  return (
    <article
      className={cx('dr-bubble', `dr-bubble--${from}`, pending && 'is-pending', failed && 'is-failed')}
      aria-busy={pending || undefined}
    >
      {meta ? <div className="dr-bubble__meta">{meta}</div> : null}
      <div className="dr-bubble__body">{children}</div>
    </article>
  )
}
