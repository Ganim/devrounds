import { DevRoundsError } from './errors/error.ts'

export function toDevRoundsError(err: unknown): DevRoundsError {
  if (err instanceof DevRoundsError) return err
  // The original error stays in data for server-side logging; the words layer never prints it to clients.
  return new DevRoundsError('DR501', { cause: err instanceof Error ? err.message : String(err) })
}
