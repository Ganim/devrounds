import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// The run.dispatch span id beside runs.trace_id (telemetry/otel.ts): a re-sent Offer carries the same traceparent,
// and run.record hangs under that span, so both need the span id, not only the trace id.
export const runsTraceSpanId: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`alter table runs add column trace_span_id text`.execute(db)
  },
}
