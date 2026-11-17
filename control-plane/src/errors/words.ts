import type { ErrorCode } from './codes.ts'

export type Words = { text: string; hint: string; httpStatus: number; keys: string[] }

// Single home for error text, hint and HTTP status. `{name}` placeholders are filled from the error data.
export const WORDS: Record<ErrorCode, Words> = {
  DR101: {
    text: 'Invalid input at {path}: {reason}.',
    hint: 'Fix the value at {path} and send the request again.',
    httpStatus: 400,
    keys: ['path', 'reason'],
  },
  DR501: {
    text: 'Internal error.',
    hint: 'Retry once; if it keeps failing, check the control plane log for the cause.',
    httpStatus: 500,
    keys: [],
  },
  DR502: {
    text: 'Control plane configuration is invalid: {reason}.',
    hint: 'Fix ~/.devrounds/server.json or the DEVROUNDS_* environment variables, then start again.',
    httpStatus: 500,
    keys: ['reason'],
  },
}
