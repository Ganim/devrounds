import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { THEME_BOOT_SCRIPT } from './src/data/prefs.ts'

// web/dist is gitignored; the control plane serves it at `/` (hash routes, so no server-side fallback is needed).
const dist = fileURLToPath(new URL('./dist/', import.meta.url))

// The theme lands on <html> before the first paint, so a reload never flashes the other theme.
const page = (title: string, name: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
    <script>${THEME_BOOT_SCRIPT}</script>
    <link rel="stylesheet" href="${name}.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${name}.js"></script>
  </body>
</html>
`

const bundle = (entry: string, name: string) =>
  build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile: `${dist}${name}.js`,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  })

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
// gallery: every primitive and pattern in both themes, no data (ui/gallery.tsx); a separate bundle, so the app's
// does not grow.
await Promise.all([bundle('./src/app/main.tsx', 'app'), bundle('./src/ui/gallery.tsx', 'gallery')])
await writeFile(`${dist}index.html`, page('DevRounds', 'app'))
await writeFile(`${dist}gallery.html`, page('DevRounds UI gallery', 'gallery'))
