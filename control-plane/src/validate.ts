import type { Static, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { fail } from './errors/error.ts'

export function validate<T extends TSchema>(schema: T, value: unknown): Static<T> {
  const first = Value.Errors(schema, value).First()
  if (first) fail('DR101', { path: first.path || '/', reason: first.message })
  return value as Static<T>
}
