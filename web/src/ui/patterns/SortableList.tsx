import { type ReactNode, useCallback } from 'react'
import { moveItem } from '../../lib/reorder.ts'
import { cx } from '../cx.ts'
import { Icon } from '../icons.tsx'
import { type DragSource, type DropTarget, itemAttrs, landingIndex, useDrag } from './drag.ts'
import './Sortable.css'

const GROUP = 'list'

/**
 * A vertical list reordered by its grips. `onReorder` gets the whole new order, so the caller applies it optimistically
 * and rolls back if the save fails (cx-env shows the revert, cxenv-03c-tasks-reverted.png). `renderItem` receives the
 * grip to place in the row (ListCard takes it as `grip`).
 */
export function SortableList<T>({
  items,
  keyOf,
  label,
  onReorder,
  renderItem,
}: {
  items: T[]
  keyOf: (item: T) => string
  label: string
  onReorder: (next: T[]) => void
  renderItem: (item: T, grip: ReactNode) => ReactNode
}) {
  const onDrop = useCallback(
    (source: DragSource, target: DropTarget) => {
      const to = landingIndex(source, target)
      if (to !== source.index) onReorder(moveItem(items, source.index, to))
    },
    [items, onReorder],
  )
  const { dragging, over, handleProps } = useDrag({ onDrop })
  return (
    <ul className="dr-sortable" aria-label={label}>
      {items.map((item, index) => {
        const key = keyOf(item)
        return (
          <li
            key={key}
            {...itemAttrs(GROUP, index)}
            className={cx(
              'dr-sortable__item',
              dragging === key && 'is-dragging',
              dragging !== null && over?.index === index && 'is-drop-before',
              dragging !== null && index === items.length - 1 && over?.index === items.length && 'is-drop-after',
            )}
          >
            {renderItem(item, <Grip label={`Move ${key}`} {...handleProps(key, GROUP, index)} />)}
          </li>
        )
      })}
    </ul>
  )
}

/** The drag handle: a focusable button so the keyboard can move the row too (ArrowUp/Down). */
export function Grip({
  label,
  ...handlers
}: { label: string } & ReturnType<ReturnType<typeof useDrag>['handleProps']>) {
  return (
    <button type="button" className="dr-grip" aria-label={`${label} (arrow keys)`} title={label} {...handlers}>
      <Icon name="grip-vertical" />
    </button>
  )
}
