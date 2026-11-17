import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderErrorDocs } from '../control-plane/src/errors/docs.ts'

await writeFile(fileURLToPath(new URL('../docs/errors.md', import.meta.url)), renderErrorDocs())
