import { type ErrorCode, exitCodeFor } from './codes.ts'
import { WORDS } from './words.ts'

type ErrorData = Record<string, unknown>

export class DevRoundsError extends Error {
  code: ErrorCode
  data: ErrorData

  constructor(code: ErrorCode, data: ErrorData = {}) {
    super(`${code}: ${fill(WORDS[code].text, data)}`)
    this.name = 'DevRoundsError'
    this.code = code
    this.data = data
  }
}

// A missing key renders a neutral marker instead of a raw {placeholder}; WORDS.keys plus a test keep this rare.
export const MISSING = '<unknown>'

function fill(template: string, data: ErrorData): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => (key in data ? String(data[key]) : MISSING))
}

export function fail(code: ErrorCode, data?: ErrorData): never {
  throw new DevRoundsError(code, data)
}

export function explain(
  code: ErrorCode,
  data: ErrorData = {},
): { text: string; hint: string; httpStatus: number; exitCode: number } {
  const words = WORDS[code]
  return {
    text: fill(words.text, data),
    hint: fill(words.hint, data),
    httpStatus: words.httpStatus,
    exitCode: exitCodeFor(code),
  }
}
