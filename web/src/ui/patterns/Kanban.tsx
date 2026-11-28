import { type ReactNode, useCallback, useMemo } from 'react'
import type { Tone } from '../../lib/tones.ts'
import { cx } from '../cx.ts'
import { Dot } from '../primitives/Dot.tsx'
import { type DragSource, type DropTarget, itemAttrs, landingIndex, useDrag, zoneAttrs } from './drag.ts'
import { Grip } from './SortableList.tsx'
import './Sortable.css'
import './Kanban.css'

export type KanbanColumn<T> = { key: string; title: string; tone?: Tone; items: T[] }

/**
 * Columns of cards moved by their grips, within a column or across (ArrowLeft/Right on a grip moves it to the next
 * column). `onMove` gets the target column and the final index there; the caller decides whether the move is allowed
 * (a task transition) and applies it optimistically. Columns scroll sideways on narrow screens.
 */
export function Kanban<T>({
  columns,
  keyOf,
  label,
  onMove,
  renderCard,
}: {
  columns: KanbanColumn<T>[]
  keyOf: (item: T) => string
  label: string
  onMove: (move: { key: string; from: string; to: string; index: number }) => void
  renderCard: (item: T, grip: ReactNode) => ReactNode
}) {
  const groups = useMemo(() => columns.map((c) => c.key), [columns])
  const sizeOf = useCallback((key: string) => columns.find((c) => c.key === key)?.items.length ?? 0, [columns])
  const onDrop = useCallback(
    (source: DragSource, target: DropTarget) => {
      const index = landingIndex(source, target)
      if (source.group === target.group && index === source.index) return
      onMove({ key: source.key, from: source.group, to: target.group, index })
    },
    [onMove],
  )
  const { dragging, over, handleProps } = useDrag({ onDrop, groups, sizeOf })
  return (
    <section className="dr-kanban" aria-label={label}>
      {columns.map((column) => (
        <div
          key={column.key}
          className={cx('dr-kanban__column', dragging !== null && over?.group === column.key && 'is-over')}
          {...zoneAttrs(column.key, column.items.length)}
        >
          <h3 className="dr-kanban__title">
            {column.tone ? <Dot tone={column.tone} /> : null}
            {column.title}
            <span className="dr-kanban__count">{column.items.length}</span>
          </h3>
          <ul className="dr-kanban__list">
            {column.items.map((item, index) => {
              const key = keyOf(item)
              const target = dragging !== null && over?.group === column.key ? over.index : null
              return (
                <li
                  key={key}
                  {...itemAttrs(column.key, index)}
                  className={cx(
                    'dr-kanban__item',
                    dragging === key && 'is-dragging',
                    target === index && 'is-drop-before',
                    target === column.items.length && index === column.items.length - 1 && 'is-drop-after',
                  )}
                >
                  {renderCard(item, <Grip label={`Move ${key}`} {...handleProps(key, column.key, index)} />)}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}
