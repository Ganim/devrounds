import type { ReactNode, TableHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import './Table.css'

/**
 * A data table in a rounded frame that scrolls sideways on narrow screens instead of widening the page. Children are
 * plain thead/tbody; a numeric cell takes `className="dr-num"` (right-aligned, tabular figures).
 */
export function Table({
  className,
  dense = false,
  children,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { dense?: boolean; children: ReactNode }) {
  return (
    <div className="dr-table-frame">
      <table {...rest} className={cx('dr-table', dense && 'dr-table--dense', className)}>
        {children}
      </table>
    </div>
  )
}
