import type { Migration } from 'kysely/migration'
import { core } from './0001_core.ts'
import { criteriaPosition } from './0002_criteria_position.ts'
import { planEventsAppendOnly } from './0003_plan_events_append_only.ts'
import { machines } from './0004_machines.ts'
import { runs } from './0005_runs.ts'

export type MigrationOptions = { appRole: string }

// Static imports on purpose: FileMigrationProvider's dynamic import breaks on Windows paths.
// Keys sort lexically and Kysely applies them in that order; never rename an applied key.
export function migrations(options: MigrationOptions): Record<string, Migration> {
  return {
    '0001_core': core(options),
    '0002_criteria_position': criteriaPosition,
    '0003_plan_events_append_only': planEventsAppendOnly(options),
    '0004_machines': machines(options),
    '0005_runs': runs,
  }
}
