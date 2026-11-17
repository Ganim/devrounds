import { ERROR_CODES } from './codes.ts'
import { WORDS } from './words.ts'

// Deterministic output (LF only, no dates) so the "docs/errors.md is current" test is stable on every OS.
export function renderErrorDocs(): string {
  const sections = ERROR_CODES.map((code) => {
    const { text, hint } = WORDS[code]
    return `## ${code}\n\n${text}\n\n### Fix\n\n${hint}\n`
  })
  return `# Error codes\n\nGenerated from control-plane/src/errors/words.ts by \`pnpm gen:errors\`. Do not edit.\n\n${sections.join('\n')}`
}
