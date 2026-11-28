import type { ButtonHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import { Icon, type IconName } from '../icons.tsx'
import './IconButton.css'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> & {
  icon: IconName
  /** Accessible name and tooltip: an icon-only button always has one. */
  label: string
  size?: 'md' | 'sm'
  variant?: 'default' | 'ghost' | 'primary'
}

export function IconButton({ icon, label, size = 'md', variant = 'default', className, ...rest }: Props) {
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      title={label}
      className={cx('dr-iconbtn', `dr-iconbtn--${variant}`, size === 'sm' && 'dr-iconbtn--sm', className)}
    >
      <Icon name={icon} />
    </button>
  )
}
