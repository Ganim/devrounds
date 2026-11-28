/**
 * Items whose text starts with `query` first, then those that only contain it, each group in its original order; case
 * is ignored and an empty query keeps everything. The cx-env slash list and model picker rank this way
 * (cx-env src/ui/commands.ts), so typing the start of a name always puts that name on top.
 */
export function rankMatches<T>(items: readonly T[], query: string, textOf: (item: T) => string): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...items]
  const starts: T[] = []
  const contains: T[] = []
  for (const item of items) {
    const text = textOf(item).toLowerCase()
    if (text.startsWith(q)) starts.push(item)
    else if (text.includes(q)) contains.push(item)
  }
  return [...starts, ...contains]
}
