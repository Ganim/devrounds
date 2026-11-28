import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the final design arrives later and must land by editing ui/tokens.css alone (P5 design §3 call 3), and every
// screen must work in dark and light. A color written anywhere else is fixed in one theme and survives a redesign, so
// it fails here. Components name semantic tokens (`var(--state-ok)`); `color-mix()` over tokens is fine.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const TOKENS = 'ui/tokens.css'

const HEX = /#[0-9a-fA-F]{3,8}\b/
const FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/
const NAMED =
  /\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta|brown|gold|indigo|violet)\b/
// In code, a hex only counts inside a string: `#/run/x` is a route and `#${id}` a fragment.
const CODE_HEX = /['"`]#[0-9a-fA-F]{3,8}['"`\s;)]/

type Source = { path: string; text: string }

/** Every color literal in `sources` (paths relative to web/src) outside ui/tokens.css. */
function colorsOutsideTokens(sources: Source[]): string[] {
  const found: string[] = []
  for (const { path, text } of sources) {
    if (path === TOKENS || path.endsWith('.test.ts')) continue
    if (path.endsWith('.css')) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, prop, value] of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
        if (HEX.test(value) || FUNCTION.test(value) || NAMED.test(value))
          found.push(`${path}: ${prop}: ${value.trim()}`)
      }
      continue
    }
    text.split('\n').forEach((line, i) => {
      if (CODE_HEX.test(line) || FUNCTION.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`)
    })
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
      return [{ path: relative(SRC, path).split(sep).join('/'), text: await readFile(path, 'utf8') }]
    }),
  )
  return nested.flat()
}

test('no color outside ui/tokens.css', async () => {
  assert.deepEqual(colorsOutsideTokens(await sources(SRC)), [])
})

test('a color outside the tokens is reported', () => {
  const found = colorsOutsideTokens([
    { path: 'ui/tokens.css', text: ':root { --x: #fff; }' },
    { path: 'ui/primitives/A.css', text: '/* #fff in a comment */ .a:hover { color: #1c2128; border: 1px solid red }' },
    {
      path: 'ui/primitives/B.css',
      text: '.b { background: rgba(0, 0, 0, 0.5); color: color-mix(in srgb, var(--x) 10%, transparent) }',
    },
    {
      path: 'features/x/Page.tsx',
      text: "const s = { color: '#fff' }\nconst href = '#/run/abc'\nconst c = 'hsl(10 20% 30%)'",
    },
    { path: 'features/x/Page.test.ts', text: "const fixture = '#123456'" },
  ])
  assert.deepEqual(found, [
    'ui/primitives/A.css: color: #1c2128',
    'ui/primitives/A.css: border: 1px solid red',
    'ui/primitives/B.css: background: rgba(0, 0, 0, 0.5)',
    "features/x/Page.tsx:1: const s = { color: '#fff' }",
    "features/x/Page.tsx:3: const c = 'hsl(10 20% 30%)'",
  ])
})
