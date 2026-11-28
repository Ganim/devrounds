import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { RunView } from '../runs/view.ts'
import { startTelemetry } from './otel.ts'

test('without an endpoint no OpenTelemetry module is loaded', async () => {
  const loaded: string[] = []
  const load = async (module: string) => {
    loaded.push(module)
    throw new Error(`${module} must not be loaded`)
  }
  assert.equal(await startTelemetry(undefined, load), null)
  assert.equal(await startTelemetry('', load), null)
  assert.deepEqual(loaded, [])
  // A static import would load the SDK with this module whatever the endpoint; only type imports may name it.
  const source = await readFile(new URL('./otel.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import (?!type )[^\n]*'@opentelemetry\//m)
})

type OtlpValue = { stringValue?: string; intValue?: string | number }
type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  attributes: { key: string; value: OtlpValue }[]
}
type OtlpBody = { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }

const attribute = (span: OtlpSpan, key: string) => span.attributes.find((a) => a.key === key)?.value.stringValue

test('with an endpoint a dispatched run exports run.dispatch carrying the run id', async () => {
  const received: { url: string | undefined; body: OtlpBody }[] = []
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpBody })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  try {
    const { port } = receiver.address() as AddressInfo
    const telemetry = await startTelemetry(`http://127.0.0.1:${port}`)
    assert.ok(telemetry)
    const runId = randomUUID()
    const traceParent = telemetry.runDispatched({ id: runId, jobType: 'check' })
    const [, traceId, dispatchSpanId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceParent) ?? []
    assert.ok(traceId && dispatchSpanId, traceParent)
    const at = new Date('2026-11-18T10:00:00Z')
    const later = new Date('2026-11-18T10:00:05Z')
    telemetry.runFinished(finishedView(runId, at, later), traceParent)
    await telemetry.shutdown()

    assert.ok(received.length > 0)
    assert.ok(received.every((r) => r.url === '/v1/traces'))
    const spans = received.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans)))
    const dispatch = spans.find((span) => span.name === 'run.dispatch')
    assert.ok(dispatch, JSON.stringify(spans))
    assert.equal(dispatch.traceId, traceId)
    assert.equal(dispatch.spanId, dispatchSpanId)
    assert.equal(attribute(dispatch, 'devrounds.run.id'), runId)
    assert.equal(attribute(dispatch, 'devrounds.job_type'), 'check')
    const record = spans.find((span) => span.name === 'run.record')
    assert.ok(record, JSON.stringify(spans))
    assert.equal(record.traceId, traceId)
    assert.equal(record.parentSpanId, dispatchSpanId)
    assert.equal(attribute(record, 'devrounds.run.id'), runId)
    assert.equal(attribute(record, 'devrounds.run.started_at'), at.toISOString())
    // The summary may quote the run's output; telemetry never carries it.
    assert.doesNotMatch(JSON.stringify(received), /hunter2/)
  } finally {
    receiver.close()
  }
})

function finishedView(id: string, at: Date, later: Date): RunView {
  return {
    id,
    state: 'failed',
    attempt: 1,
    jobType: 'check',
    machine: 'build-01',
    queue: 'default',
    cause: 'first',
    notBefore: at,
    task: null,
    cachedFrom: null,
    environment: null,
    timeline: { queuedAt: at, offeredAt: at, admittedAt: at, startedAt: at, finishedAt: later },
    durations: { queueWaitMs: 0, admissionDelayMs: 0, runTimeMs: 5000, totalMs: 5000 },
    outcome: { exitCode: 1, failureClass: 'check_red', failureSummary: 'API_KEY=hunter2', logCursor: null },
    resources: { peak: 1, p95: 1, p50: 1, cpuSeconds: 1, swept: 0, visibleWindows: 0 },
    steps: [],
    delays: [],
    agent: null,
  }
}
