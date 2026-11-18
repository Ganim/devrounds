import { parentPort, workerData } from 'node:worker_threads'

// Runs tenant-written log patterns off the control plane's event loop (see matchPatterns in classify.ts). Posts one
// result per pattern, in order, and stops at the first that matches, so the parent knows which one a timeout hit.
const { patterns, lines, limit } = workerData as { patterns: string[]; lines: string[]; limit: number }

for (const [index, source] of patterns.entries()) {
  const pattern = new RegExp(source)
  const matched: string[] = []
  for (const line of lines) {
    if (!pattern.test(line)) continue
    matched.push(line)
    if (matched.length >= limit) break
  }
  parentPort?.postMessage({ index, matched })
  if (matched.length > 0) break
}
