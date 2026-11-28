import { type ReactNode, useId } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import './tone.css'
import './Ring.css'

const R = 18
const CIRCUMFERENCE = 2 * Math.PI * R

/**
 * A circular gauge (cx-env CPU/RAM/Docker strip). `value` is 0..1 and clamps. Without a `tone` the arc is the accent
 * gradient; a resource gauge passes warn or danger past its threshold. `children` render in the middle.
 */
export function Ring({
  value,
  tone,
  size = 'md',
  label,
  children,
}: {
  value: number
  tone?: Tone
  size?: 'sm' | 'md' | 'lg'
  label: string
  children?: ReactNode
}) {
  // One gradient per ring: a shared id breaks when the first ring holding it unmounts.
  const gradient = useId()
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  return (
    <span
      className={cx('dr-ring', `dr-ring--${size}`, tone && `dr-tone-${tone} dr-ring--toned`)}
      role="img"
      aria-label={`${label} ${Math.round(v * 100)}%`}
    >
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="dr-ring__stop-a" />
            <stop offset="1" className="dr-ring__stop-b" />
          </linearGradient>
        </defs>
        <circle className="dr-ring__track" cx="22" cy="22" r={R} />
        <circle
          className="dr-ring__arc"
          cx="22"
          cy="22"
          r={R}
          stroke={tone ? undefined : `url(#${gradient})`}
          strokeDasharray={`${v * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
      {children !== undefined ? <span className="dr-ring__center">{children}</span> : null}
    </span>
  )
}
