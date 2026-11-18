import type * as Api from '@opentelemetry/api'
import type * as Exporter from '@opentelemetry/exporter-trace-otlp-http'
import type * as Resources from '@opentelemetry/resources'
import type * as Sdk from '@opentelemetry/sdk-trace'
import pkg from '../../package.json' with { type: 'json' }
import type { RunView } from '../runs/view.ts'

// OpenTelemetry is off unless `otlpEndpoint` is set. The SDK is only ever loaded through `load` once an endpoint is
// configured, so a control plane without one never parses it nor keeps its batch timer (only type imports above).
// Spans carry run ids, job types, states and times; never output, failure summaries, env or commands.

export type Telemetry = {
  /** Exports the `run.dispatch` span of a run being offered; its W3C traceparent goes in the Offer. */
  runDispatched(run: { id: string; jobType: string }): string
  /** Exports `run.record`, the run's timeline from queued to finished, under the dispatch span of `traceParent`. */
  runFinished(view: RunView, traceParent: string | null): void
  /** Sends what is still batched and stops the exporter. */
  shutdown(): Promise<void>
}

const SERVICE = 'devrounds-control-plane'
const TRACE_PARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
const ZERO = /^0+$/

/** The trace id and parent span id of a W3C traceparent; null for anything else. */
export function parseTraceParent(value: string | null): { traceId: string; spanId: string } | null {
  const match = value === null ? null : TRACE_PARENT.exec(value)
  if (!match?.[1] || !match[2] || ZERO.test(match[1]) || ZERO.test(match[2])) return null
  return { traceId: match[1], spanId: match[2] }
}

/** The sampled traceparent of a span; the format parseTraceParent reads. */
export function formatTraceParent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`
}

/**
 * The exporter for `endpoint`, the collector's OTLP/HTTP base URL (`/v1/traces` is appended, as with
 * OTEL_EXPORTER_OTLP_ENDPOINT); null, with nothing loaded, when there is none.
 */
export async function startTelemetry(
  endpoint: string | undefined,
  load: (module: string) => Promise<unknown> = (module) => import(module),
): Promise<Telemetry | null> {
  const base = endpoint?.trim()
  if (!base) return null
  const [api, sdk, exporter, resources] = (await Promise.all([
    load('@opentelemetry/api'),
    load('@opentelemetry/sdk-trace'),
    load('@opentelemetry/exporter-trace-otlp-http'),
    load('@opentelemetry/resources'),
  ])) as [typeof Api, typeof Sdk, typeof Exporter, typeof Resources]
  const provider = new sdk.TracerProvider({
    resource: resources.resourceFromAttributes({ 'service.name': SERVICE, 'service.version': pkg.version }),
    spanProcessors: [
      new sdk.BatchSpanProcessor({
        exporter: new exporter.OTLPTraceExporter({ url: `${base.replace(/\/+$/, '')}/v1/traces` }),
      }),
    ],
  })
  const tracer = provider.getTracer(SERVICE, pkg.version)

  return {
    runDispatched(run) {
      const span = tracer.startSpan(
        'run.dispatch',
        { attributes: { 'devrounds.run.id': run.id, 'devrounds.job_type': run.jobType } },
        api.ROOT_CONTEXT,
      )
      span.end()
      const { traceId, spanId } = span.spanContext()
      return formatTraceParent(traceId, spanId)
    },

    runFinished(view, traceParent) {
      const parent = parseTraceParent(traceParent)
      const context = parent
        ? api.trace.setSpanContext(api.ROOT_CONTEXT, { ...parent, traceFlags: api.TraceFlags.SAMPLED, isRemote: true })
        : api.ROOT_CONTEXT
      const { timeline, durations } = view
      const attributes: Api.Attributes = {
        'devrounds.run.id': view.id,
        'devrounds.job_type': view.jobType,
        'devrounds.machine': view.machine,
        'devrounds.run.state': view.state,
        'devrounds.run.attempt': view.attempt,
      }
      const times: [string, Date | null][] = [
        ['queued_at', timeline.queuedAt],
        ['offered_at', timeline.offeredAt],
        ['admitted_at', timeline.admittedAt],
        ['started_at', timeline.startedAt],
        ['finished_at', timeline.finishedAt],
      ]
      for (const [name, at] of times) if (at) attributes[`devrounds.run.${name}`] = at.toISOString()
      const spans: [string, number | null][] = [
        ['queue_wait_ms', durations.queueWaitMs],
        ['admission_delay_ms', durations.admissionDelayMs],
        ['run_time_ms', durations.runTimeMs],
        ['total_ms', durations.totalMs],
      ]
      for (const [name, ms] of spans) if (ms !== null) attributes[`devrounds.run.${name}`] = ms
      if (view.outcome.exitCode !== null) attributes['devrounds.exit_code'] = view.outcome.exitCode
      if (view.outcome.failureClass !== null) attributes['devrounds.failure_class'] = view.outcome.failureClass
      const span = tracer.startSpan('run.record', { startTime: timeline.queuedAt, attributes }, context)
      span.end(timeline.finishedAt ?? new Date())
    },

    shutdown: () => provider.shutdown(),
  }
}
