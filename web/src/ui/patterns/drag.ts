import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from 'react'

/** Where a dragged item would land: `index` is the insertion point in `group` before the item leaves its place. */
export type DropTarget = { group: string; index: number }
export type DragSource = { key: string; group: string; index: number }

const ITEM = 'data-dr-drag-index'
const ITEM_GROUP = 'data-dr-drag-group'
const ZONE = 'data-dr-drop-group'
const ZONE_COUNT = 'data-dr-drop-count'

/** Attributes for an item that can be hovered as a drop position. */
export const itemAttrs = (group: string, index: number) => ({ [ITEM_GROUP]: group, [ITEM]: index })
/** Attributes for a container (a column) that takes a drop at its end, also when empty. */
export const zoneAttrs = (group: string, count: number) => ({ [ZONE]: group, [ZONE_COUNT]: count })

/**
 * The final index for `moveItem` when an item moves inside its own group: the insertion point counts the item itself,
 * so a move downward lands one earlier.
 */
export const landingIndex = (source: DragSource, target: DropTarget) =>
  source.group === target.group && target.index > source.index ? target.index - 1 : target.index

function targetAt(x: number, y: number): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const item = el.closest<HTMLElement>(`[${ITEM}]`)
    if (item) {
      const rect = item.getBoundingClientRect()
      const index = Number(item.getAttribute(ITEM))
      return { group: item.getAttribute(ITEM_GROUP) ?? '', index: y > rect.top + rect.height / 2 ? index + 1 : index }
    }
    const zone = el.closest<HTMLElement>(`[${ZONE}]`)
    if (zone) return { group: zone.getAttribute(ZONE) ?? '', index: Number(zone.getAttribute(ZONE_COUNT)) }
  }
  return null
}

/**
 * Pointer drag from a grip, so it works with a finger as well as a mouse (cx-env drags cards by the grip only; the
 * card itself opens the panel). Keyboard fallback on the grip: ArrowUp/Down move one place, ArrowLeft/Right move to
 * the end of the neighbouring group in `groups` (kanban columns).
 */
export function useDrag({
  onDrop,
  groups = [],
  sizeOf,
}: {
  onDrop: (source: DragSource, target: DropTarget) => void
  groups?: string[]
  sizeOf?: (group: string) => number
}) {
  const [source, setSource] = useState<DragSource | null>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  const latest = useRef({ source, over, onDrop })
  latest.current = { source, over, onDrop }

  useEffect(() => {
    if (!source) return
    const move = (event: globalThis.PointerEvent) => setOver(targetAt(event.clientX, event.clientY))
    const end = (event: globalThis.PointerEvent) => {
      const { source: from, over: to, onDrop: drop } = latest.current
      setSource(null)
      setOver(null)
      document.body.classList.remove('dr-dragging')
      if (event.type === 'pointerup' && from && to) drop(from, to)
    }
    document.body.classList.add('dr-dragging')
    addEventListener('pointermove', move)
    addEventListener('pointerup', end)
    addEventListener('pointercancel', end)
    return () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', end)
      removeEventListener('pointercancel', end)
    }
  }, [source])

  const handleProps = useCallback(
    (key: string, group: string, index: number) => ({
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        setSource({ key, group, index })
        setOver({ group, index })
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const from = { key, group, index }
        const column = groups.indexOf(group)
        let to: DropTarget | null = null
        if (event.key === 'ArrowUp' && index > 0) to = { group, index: index - 1 }
        if (event.key === 'ArrowDown') to = { group, index: index + 2 }
        const side = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
        if (side !== 0 && column >= 0 && groups[column + side] !== undefined) {
          const next = groups[column + side]
          to = { group: next, index: sizeOf?.(next) ?? 0 }
        }
        if (!to) return
        event.preventDefault()
        onDrop(from, to)
      },
    }),
    [groups, sizeOf, onDrop],
  )

  return { dragging: source?.key ?? null, over, handleProps }
}
