import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { cx } from '../cx.ts'
import { Icon, type IconName } from '../icons.tsx'
import { IconButton } from './IconButton.tsx'
import { type Placement, Popover } from './Popover.tsx'
import './Menu.css'

export type MenuItem = { key: string; label: string; icon?: IconName; danger?: boolean; disabled?: boolean }

/**
 * A "…" button opening a list of actions. Arrow keys move, Enter picks, Esc closes; focus goes to the first item on
 * open and back to the button on close.
 */
export function Menu({
  label,
  items,
  onSelect,
  icon = 'ellipsis',
  placement = 'bottom-end',
}: {
  label: string
  items: MenuItem[]
  onSelect: (key: string) => void
  icon?: IconName
  placement?: Placement
}) {
  const [open, setOpen] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const trigger = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    else if (wasOpen.current) trigger.current?.querySelector('button')?.focus()
    wasOpen.current = open
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    buttons[(at + step + buttons.length) % buttons.length]?.focus()
  }

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      placement={placement}
      label={label}
      anchor={
        <span ref={trigger} className="dr-menu-trigger">
          <IconButton
            icon={icon}
            label={label}
            size="sm"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          />
        </span>
      }
    >
      <div ref={list} className="dr-menu" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cx('dr-menu__item', item.danger && 'is-danger')}
            onClick={() => {
              setOpen(false)
              onSelect(item.key)
            }}
          >
            {item.icon ? <Icon name={item.icon} /> : null}
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  )
}
