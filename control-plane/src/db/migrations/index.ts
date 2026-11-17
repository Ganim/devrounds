import type { Migration } from 'kysely/migration'
import { core } from './0001_core.ts'

export type MigrationOptions = { appRole: string }

// Static imports on purpose: FileMigrationProvider's dynamic import breaks on Windows paths.
// Keys sort lexically and Kysely applies them in that order; never rename an applied key.
export function migrations(options: MigrationOptions): Record<string, Migration> {
  return {
    '0001_core': core(options),
  }
}
