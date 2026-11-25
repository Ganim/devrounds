import { type ConventionsDef, canonical } from './file.ts'

// severity: the newer side's for added and changed, the removed rule's for removed; null for a fact. A changed rule
// whose severity moved lists `severity` in fields, so it was or is blocking.
export type DiffItem = { key: string; item: 'rule' | 'fact'; severity: 'warn' | 'block' | null }

export type VersionDiff = {
  added: DiffItem[]
  removed: DiffItem[]
  changed: (DiffItem & { fields: string[] })[]
  targets: { added: string[]; removed: string[] }
}

type Item = { key: string; item: 'rule' | 'fact'; severity: 'warn' | 'block' | null; value: Record<string, unknown> }

function itemsOf(def: ConventionsDef): Map<string, Item> {
  const items = new Map<string, Item>()
  for (const rule of def.rules)
    items.set(rule.key, { key: rule.key, item: 'rule', severity: rule.severity, value: rule })
  for (const fact of def.facts) items.set(fact.key, { key: fact.key, item: 'fact', severity: null, value: fact })
  return items
}

const entry = ({ key, item, severity }: Item): DiffItem => ({ key, item, severity })

/**
 * What `b` changes from `a`, by key (plan call 7): items added, removed and changed (the fields that differ, by name,
 * sorted), and targets added and removed. Compares the defs, so a default written out is no change. A key that moves
 * between a rule and a fact is changed with field `item`. Items keep `b`'s order (`a`'s for removed).
 */
export function diffVersions(a: ConventionsDef, b: ConventionsDef): VersionDiff {
  const before = itemsOf(a)
  const after = itemsOf(b)
  const changed: VersionDiff['changed'] = []
  for (const next of after.values()) {
    const prev = before.get(next.key)
    if (!prev) continue
    const names = [...new Set([...Object.keys(prev.value), ...Object.keys(next.value)])].sort()
    const fields = names.filter((name) => canonical(prev.value[name]) !== canonical(next.value[name]))
    if (prev.item !== next.item) fields.unshift('item')
    if (fields.length > 0) changed.push({ ...entry(next), fields })
  }
  const targetsOf = (def: ConventionsDef) => new Set(def.targets.map((target) => target.path))
  const [targetsBefore, targetsAfter] = [targetsOf(a), targetsOf(b)]
  return {
    added: [...after.values()].filter((item) => !before.has(item.key)).map(entry),
    removed: [...before.values()].filter((item) => !after.has(item.key)).map(entry),
    changed,
    targets: {
      added: [...targetsAfter].filter((path) => !targetsBefore.has(path)),
      removed: [...targetsBefore].filter((path) => !targetsAfter.has(path)),
    },
  }
}
