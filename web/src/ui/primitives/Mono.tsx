import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import './Mono.css'

/** Ids, keys, paths, figures: monospace; `muted` for the secondary ones (cx-env meta lines). */
export function Mono({ muted = false, title, children }: { muted?: boolean; title?: string; children: ReactNode }) {
  return (
    <span className={cx('dr-mono', muted && 'dr-mono--muted')} title={title}>
      {children}
    </span>
  )
}
