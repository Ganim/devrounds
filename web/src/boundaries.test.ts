import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: pages that fetch, lay out and style in one file are what P5 set out to remove (P5 design §3 call 2). Imports go
// downward only: app -> features -> (ui, data, lib); ui imports ui and lib; data imports data and lib; lib imports
// lib. A feature never imports another feature: a shared piece moves to ui/patterns or lib. Server types reach the web
// through data/contract.ts only, type-only, so the bundle never pulls in control-plane code.

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const LAYERS = ['app', 'features', 'ui', 'data', 'lib'] as const
type Layer = (typeof LAYERS)[number]

const MAY_IMPORT: Record<Layer, Layer[]> = {
  app: ['app', 'features', 'ui', 'data', 'lib'],
  features: ['features', 'ui', 'data', 'lib'],
  ui: ['ui', 'lib'],
  data: ['data', 'lib'],
  lib: ['lib'],
}
const SERVER_TYPES_FILE = 'data/contract.ts'
// A package only one layer may import: the query cache belongs to data/resources.ts (P5 design §3 call 4).
const PACKAGE_OWNER: [prefix: string, layer: Layer][] = [['@tanstack/', 'data']]
// The meta-tests at the root read the whole tree and build the server; they are not part of the bundle.
const ROOT_TESTS = ['boundaries.test.ts', 'contract.test.ts']

const IMPORT = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g

type Source = { path: string; text: string }

/** Every import in `sources` (paths relative to web/src, `/`-separated) that breaks a layer rule. */
function violations(sources: Source[]): string[] {
  const found: string[] = []
  for (const { path, text } of sources) {
    if (ROOT_TESTS.includes(path)) continue
    const layer = path.split('/')[0] as Layer
    if (!LAYERS.includes(layer)) {
      found.push(`${path}: outside ${LAYERS.join(', ')}`)
      continue
    }
    for (const match of text.matchAll(IMPORT)) {
      const typeOnly = match[2] !== undefined
      const spec = match[3] ?? match[4]
      const at = `${path}: '${spec}'`
      if (!spec.startsWith('.')) {
        const owner = PACKAGE_OWNER.find(([prefix]) => spec.startsWith(prefix))
        if (owner && owner[1] !== layer) found.push(`${at}: only ${owner[1]} imports ${owner[0]}`)
        continue
      }
      const target = join(dirname(path), spec).split(sep).join('/')
      if (target.startsWith('../../control-plane/')) {
        if (path !== SERVER_TYPES_FILE) found.push(`${at}: server types come through ${SERVER_TYPES_FILE}`)
        else if (!typeOnly) found.push(`${at}: use import type`)
        continue
      }
      const [targetLayer, targetFeature] = target.split('/') as [Layer, string]
      if (!LAYERS.includes(targetLayer)) found.push(`${at}: outside ${LAYERS.join(', ')}`)
      else if (!MAY_IMPORT[layer].includes(targetLayer)) found.push(`${at}: ${layer} may not import ${targetLayer}`)
      else if (layer === 'features' && targetLayer === 'features' && targetFeature !== path.split('/')[1]) {
        found.push(`${at}: a feature never imports another feature`)
      }
    }
  }
  return found
}

async function sources(dir: string): Promise<Source[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      if (!/\.(ts|tsx|css)$/.test(entry.name)) return []
      return [{ path: relative(ROOT, path).split(sep).join('/'), text: await readFile(path, 'utf8') }]
    }),
  )
  return nested.flat()
}

test('web/src imports follow the layer rules', async () => {
  assert.deepEqual(violations(await sources(ROOT)), [])
})

test('a broken layer rule is reported', () => {
  const found = violations([
    { path: 'ui/Bad.tsx', text: "import { useRuns } from '../data/resources.ts'" },
    { path: 'features/jobs/Bad.tsx', text: "import {\n  RunState,\n} from '../runs/RunState.tsx'" },
    { path: 'lib/bad.ts', text: "import type { PlanView } from '../../../control-plane/src/planning/view.ts'" },
    { path: 'data/contract.ts', text: "import { buildServer } from '../../../control-plane/src/api/server.ts'" },
    { path: 'features/runs/Bad.tsx', text: "const page = import('../../app/main.tsx')" },
    { path: 'features/runs/Query.tsx', text: "import { useQuery } from '@tanstack/react-query'" },
    { path: 'Stray.tsx', text: '' },
  ])
  assert.deepEqual(found, [
    "ui/Bad.tsx: '../data/resources.ts': ui may not import data",
    "features/jobs/Bad.tsx: '../runs/RunState.tsx': a feature never imports another feature",
    "lib/bad.ts: '../../../control-plane/src/planning/view.ts': server types come through data/contract.ts",
    "data/contract.ts: '../../../control-plane/src/api/server.ts': use import type",
    "features/runs/Bad.tsx: '../../app/main.tsx': features may not import app",
    "features/runs/Query.tsx: '@tanstack/react-query': only data imports @tanstack/",
    'Stray.tsx: outside app, features, ui, data, lib',
  ])
})
