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
import { jobRetry } from './0012_job_retry.ts'
import { offerExpiry } from './0013_offer_expiry.ts'
import { schedules } from './0014_schedules.ts'
import { idempotencySweep } from './0015_idempotency_sweep.ts'
import { auth } from './0016_auth.ts'
import { runsPlacedHaveMachine } from './0017_runs_placed_have_machine.ts'
import { jobEnv } from './0018_job_env.ts'
import { placement } from './0019_placement.ts'
import { resultCache } from './0020_result_cache.ts'
import { gates } from './0021_gates.ts'
import { taskSourceKey } from './0022_task_source_key.ts'
import { learnedNeedP90 } from './0023_learned_need_p90.ts'
import { conventionSets } from './0024_convention_sets.ts'
import { conventionChecks } from './0025_convention_checks.ts'
import { conventionCheckCounts } from './0026_convention_check_counts.ts'
import { claimRunningNeed } from './0027_claim_running_need.ts'

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
    '0012_job_retry': jobRetry,
    '0013_offer_expiry': offerExpiry(options),
    '0014_schedules': schedules(options),
    '0015_idempotency_sweep': idempotencySweep(options),
    '0016_auth': auth(options),
    '0017_runs_placed_have_machine': runsPlacedHaveMachine,
    '0018_job_env': jobEnv,
    '0019_placement': placement,
    '0020_result_cache': resultCache,
    '0021_gates': gates,
    '0022_task_source_key': taskSourceKey,
    '0023_learned_need_p90': learnedNeedP90,
    '0024_convention_sets': conventionSets,
    '0025_convention_checks': conventionChecks,
    '0026_convention_check_counts': conventionCheckCounts,
    '0027_claim_running_need': claimRunningNeed(options),
  }
}
