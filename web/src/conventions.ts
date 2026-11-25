// Types only: erased by esbuild, so the web bundle never pulls in server code.
import type { DiffItem, VersionDiff } from '../../control-plane/src/conventions/diff-versions.ts'

export type DiffEntry = DiffItem & { verb: 'removed' | 'changed' | 'added'; fields: string[]; blocking: boolean }

/**
 * A version diff in the order an approver reads it, as `devrounds conventions diff` prints it (cli/output.ts): removed
 * and changed blocking rules first (a changed rule whose severity moved counts, since it was or is blocking), then the
 * other removed and changed items, then the added ones. Targets are listed apart.
 */
export function diffEntries(d: VersionDiff): DiffEntry[] {
  const blocking = (x: DiffItem, fields: string[]) =>
    x.item === 'rule' && (x.severity === 'block' || fields.includes('severity'))
  const touched: DiffEntry[] = [
    ...d.removed.map((x) => ({ ...x, verb: 'removed' as const, fields: [], blocking: blocking(x, []) })),
    ...d.changed.map((x) => ({ ...x, verb: 'changed' as const, blocking: blocking(x, x.fields) })),
  ]
  return [
    ...touched.filter((x) => x.blocking),
    ...touched.filter((x) => !x.blocking),
    ...d.added.map((x) => ({ ...x, verb: 'added' as const, fields: [], blocking: blocking(x, []) })),
  ]
}

/** Items grouped by `section`, sections in first-seen order (the order render uses), items in document order. */
export function bySection<T extends { section: string }>(items: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.section)
    if (group) group.push(item)
    else groups.set(item.section, [item])
  }
  return [...groups]
}
