import { fail } from '../../errors/error.ts'
import { PROMPT_MAX } from './contract.ts'

// Prompt templates read only the job: `{{job.args.N}}` (its args, from 0) and `{{input.<key>}}` (its input). No
// expressions, filters or defaults (P4 design §2.C 17): a template that needs logic is a job that computes the value.
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g
const ARG = /^job\.args\.(0|[1-9][0-9]{0,2})$/
const INPUT = /^input\.([A-Za-z_][A-Za-z0-9_-]{0,63})$/

export type PromptValues = { args: string[]; input: Record<string, string> }

/** The first placeholder of `template` that is neither form, or null. */
export function badPlaceholder(template: string): string | null {
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!ARG.test(match[1]) && !INPUT.test(match[1])) return match[0]
  }
  return null
}

/**
 * `template` with every placeholder filled from `values`; DR101 at `path` for a value the job lacks or a prompt past
 * PROMPT_MAX. Enqueue renders it once to refuse such a job before it queues; dispatch renders it again for the Offer.
 */
export function renderPrompt(template: string, values: PromptValues, path = ''): string {
  const rendered = template.replace(PLACEHOLDER, (whole, name: string) => {
    const arg = ARG.exec(name)
    if (arg) {
      const value = values.args[Number(arg[1])]
      if (value === undefined) fail('DR101', { path: `${path}/args`, reason: `the prompt reads ${whole}, missing` })
      return value
    }
    const input = INPUT.exec(name)
    const value = input ? values.input[input[1]] : undefined
    if (value === undefined) fail('DR101', { path: `${path}/input`, reason: `the prompt reads ${whole}, missing` })
    return value
  })
  if (rendered.length > PROMPT_MAX) {
    fail('DR101', {
      path: `${path}/input`,
      reason: `the prompt renders to ${rendered.length} characters (max ${PROMPT_MAX})`,
    })
  }
  return rendered
}
