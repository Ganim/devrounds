import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { rankMatches } from '../../lib/rank.ts'
import { cx } from '../cx.ts'
import { Icon } from '../icons.tsx'
import './Combobox.css'

export type ComboItem = { value: string; label: string; hint?: string; group?: string }

/**
 * A search box over a list (the model picker and the slash list). Typing ranks prefix matches first, then the rest
 * that contain the text (lib/rank.ts); ArrowUp/Down move, Enter picks, and the list keeps the active row in view.
 * Rendered inline: put it in a Dialog (model picker) or a Popover (slash list).
 */
export function Combobox({
  items,
  onSelect,
  label,
  placeholder = 'Search...',
  selected,
  empty = 'No match',
  autoFocus = false,
}: {
  items: ComboItem[]
  onSelect: (value: string) => void
  label: string
  placeholder?: string
  selected?: string
  empty?: ReactNode
  autoFocus?: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // A picker opened on purpose is where the person types next.
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])
  const shown = useMemo(() => rankMatches(items, query, (item) => `${item.label} ${item.value}`), [items, query])
  // Keep the active row in view by scrolling the list only: scrollIntoView would also scroll the page.
  useEffect(() => {
    const box = list.current
    const row = document.getElementById(`${id}-option-${active}`)
    if (!box || !row) return
    // The list is position: relative, so offsetTop is measured from it.
    const top = row.offsetTop
    if (top < box.scrollTop) box.scrollTop = top
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top + row.offsetHeight - box.clientHeight
  }, [id, active])
  const optionId = (i: number) => `${id}-option-${i}`

  return (
    <div className="dr-combo">
      <div className="dr-combo__search">
        <Icon name="search" />
        <input
          ref={input}
          className="dr-combo__input"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={shown.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              setActive((at) => (shown.length === 0 ? 0 : (at + step + shown.length) % shown.length))
            } else if (event.key === 'Enter' && shown[active]) {
              event.preventDefault()
              onSelect(shown[active].value)
            }
          }}
        />
      </div>
      <div ref={list} id={`${id}-list`} className="dr-combo__list" role="listbox" aria-label={label}>
        {shown.length === 0 ? <div className="dr-combo__empty">{empty}</div> : null}
        {shown.map((item, i) => (
          <div
            key={item.value}
            id={optionId(i)}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={cx('dr-combo__option', i === active && 'is-active')}
            onPointerMove={() => setActive(i)}
            // Pointer down, not click: the input keeps focus, and the keyboard reaches options through it.
            onPointerDown={(event) => {
              event.preventDefault()
              onSelect(item.value)
            }}
          >
            <span className="dr-combo__label">{item.label}</span>
            {item.hint ? <span className="dr-combo__hint">{item.hint}</span> : null}
            {item.value === selected ? <Icon name="check" className="dr-combo__tick" label="current" /> : null}
          </div>
        ))}
      </div>
    </div>
  )
}
