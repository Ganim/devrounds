import { type ButtonHTMLAttributes, type ReactNode, useEffect, useState } from 'react'
import { cx } from '../cx.ts'
import { Icon, type IconName } from '../icons.tsx'
import './Button.css'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: IconName
  /**
   * Destructive actions confirm by a second click (cx-env: second-click confirms, no modal): the first click arms the
   * button and shows this text; it disarms after 4 s or on blur.
   */
  confirm?: string
  type?: 'button' | 'submit'
  children?: ReactNode
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  confirm,
  type = 'button',
  className,
  children,
  onClick,
  onBlur,
  ...rest
}: Props) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <button
      {...rest}
      // biome's useButtonType wants a literal; the union above keeps it to button or submit.
      type={type === 'submit' ? 'submit' : 'button'}
      className={cx('dr-btn', `dr-btn--${variant}`, size === 'sm' && 'dr-btn--sm', armed && 'is-armed', className)}
      onClick={(event) => {
        if (confirm && !armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onClick?.(event)
      }}
      onBlur={(event) => {
        setArmed(false)
        onBlur?.(event)
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {armed ? confirm : children}
    </button>
  )
}
