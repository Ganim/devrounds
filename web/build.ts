import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// web/dist is gitignored; the control plane serves it at `/` (hash routes, so no server-side fallback is needed).
const dist = fileURLToPath(new URL('./dist/', import.meta.url))

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await build({
  entryPoints: [fileURLToPath(new URL('./src/app/main.tsx', import.meta.url))],
  outfile: `${dist}app.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
await writeFile(
  `${dist}index.html`,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DevRounds</title>
    <link rel="stylesheet" href="app.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="app.js"></script>
  </body>
</html>
`,
)
