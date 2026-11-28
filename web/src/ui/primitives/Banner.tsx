import type { ReactNode } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { Icon, type IconName } from '../icons.tsx'
import './tone.css'
import './Banner.css'

const ICON: Partial<Record<Tone, IconName>> = { danger: 'circle-alert', warn: 'triangle-alert', info: 'info' }

/** A tinted notice across the content (cx-env `.banner`); danger is the error box. */
export function Banner({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const icon = ICON[tone]
  return (
    <div className={`dr-banner dr-tone-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {icon ? <Icon name={icon} /> : null}
      <div className="dr-banner__body">{children}</div>
    </div>
  )
}
