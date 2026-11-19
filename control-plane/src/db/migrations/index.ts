import type { Migration } from 'kysely/migration'
import { core } from './0001_core.ts'
import { criteriaPosition } from './0002_criteria_position.ts'
import { planEventsAppendOnly } from './0003_plan_events_append_only.ts'
import { machines } from './0004_machines.ts'
import { runs } from './0005_runs.ts'
import { logSegments } from './0006_log_segments.ts'
import { fkIndexes } from './0007_fk_indexes.ts'
import { runsOrphanedAt } from './0008_runs_orphaned_at.ts'
import { runsTraceSpanId } from './0009_runs_trace_span_id.ts'
import { queues } from './0010_queues.ts'
import { claimRun } from './0011_claim_run.ts'

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
    '0006_log_segments': logSegments(options),
    '0007_fk_indexes': fkIndexes,
    '0008_runs_orphaned_at': runsOrphanedAt,
    '0009_runs_trace_span_id': runsTraceSpanId,
    '0010_queues': queues,
    '0011_claim_run': claimRun(options),
  }
}
