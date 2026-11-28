import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { buildServer } from '../../api/server.ts'
import { DevRoundsError } from '../../errors/error.ts'
import { Sessions } from '../../executor/gateway.ts'
import { FEATURES } from '../../executor/protocol.ts'
import type { JobTypeFile } from '../../job-types/file.ts'
import { putJobType } from '../../job-types/service.ts'
import { enqueueRun } from '../../jobs/enqueue.ts'
import { createPairingCode, PairingLimiter, redeemPairingCode } from '../../machines/pairing.ts'
import type { Ctx } from '../../planning/resolve.ts'
import { createProject } from '../../planning/service.ts'
import { waitForRun } from '../../runs/dispatch.ts'
import { runView } from '../../runs/view.ts'
import { unplacedReasons } from '../../scheduler/placeable.ts'
import { Scheduler } from '../../scheduler/scheduler.ts'
import { TEST_DATABASE_URL, type TestDb, testDb } from '../../test-support/db.ts'
import { setBudget } from './budgets.ts'
import { reportResult } from './results.ts'

// Agent runs end to end through the gateway and the scheduler, with test-support/fake-agent.ts as the runtime: the
// test plays the executor, runs the Offer's command itself and ships its stdout as the run's log segment.

const projectKey = 'devrounds'
const GIB = 1024 * 1024 * 1024
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE_AGENT = fileURLToPath(new URL('../../test-support/fake-agent.ts', import.meta.url))
const run = promisify(execFile)

let t: TestDb
let sessions: Sessions
let scheduler: Scheduler
let app: ReturnType<typeof buildServer>
let host: string
let scratch: string

before(async () => {
  t = await testDb()
  sessions = new Sessions()
  await mkdir(join(REPO_ROOT, '.superpowers', 'tmp'), { recursive: true })
  scratch = await mkdtemp(join(REPO_ROOT, '.superpowers', 'tmp', 'agent-runs-'))
  scheduler = new Scheduler({ db: t.db, sessions, offerTimeoutS: 120, pollMs: 600_000, telemetry: null, log: console })
  app = buildServer({ db: t.db, logger: false, sessions, scheduler, logsRoot: join(scratch, 'logs'), telemetry: null })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  host = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  await scheduler.start(TEST_DATABASE_URL)
})

after(async () => {
  await scheduler.stop()
  await app.close()
  await rm(scratch, { recursive: true, force: true })
})

const code = (expected: string) => (err: unknown) => err instanceof DevRoundsError && err.code === expected

// An agent job type running the fake agent; `agent` and `rest` override the block and the file.
function agentType(key: string, agent: Partial<NonNullable<JobTypeFile['agent']>>, rest: Partial<JobTypeFile> = {}) {
  return {
    key,
    command: { program: process.execPath, args: [FAKE_AGENT] },
    env: ['PATH'],
    timeout_s: 600,
    stall_s: 900,
    args_from_job: true,
    agent: {
      runtime: 'claude-code',
      prompt: '{{input.prompt}}',
      result: { kind: 'reported' as const, done: ['shipped'], park: ['needs_human'] },
      ...agent,
    },
    ...rest,
  } satisfies JobTypeFile
}

async function setup() {
  const tenant = await t.newTenant()
  const ctx: Ctx = { db: t.db, tenantId: tenant.tenantId, actor: { id: tenant.human.id, kind: 'human' } }
  const agentCtx: Ctx = { ...ctx, actor: { id: tenant.agent.id, kind: 'agent' } }
  await createProject(ctx, { key: projectKey, name: 'DevRounds' })
  await putJobType(ctx, projectKey, agentType('work', {}))
  const { code: pairing } = await createPairingCode(ctx, 'build-01')
  const machine = await redeemPairingCode(
    t.db,
    new PairingLimiter(),
    pairing,
    { os: 'windows', version: '0.1.0' },
    '127.0.0.1',
  )
  const enqueue = (prompt: string, jobTypeKey = 'work') =>
    enqueueRun(agentCtx, { projectKey, jobTypeKey, cwd: 'C:\\work', input: { prompt } })
  return { tenant, ctx, agentCtx, machine, enqueue }
}

type Message = { type: string; [field: string]: unknown }
type Offer = {
  run: string
  job: { program: string; args: string[]; env_set: Record<string, string>; stall_s?: number }
}

async function executor(token: string) {
  const ws = new WebSocket(`ws://${host}/api/executor/connect`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[])
  const inbox: Message[] = []
  let wake: (() => void) | undefined
  ws.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)))
    wake?.()
  })
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()))
  const next = async (): Promise<Message> => {
    while (inbox.length === 0) await new Promise<void>((resolve) => (wake = resolve))
    return inbox.shift() as Message
  }
  ws.send(JSON.stringify({ type: 'Hello', protocol: 1, version: '0.1.0', features: [...FEATURES], boot_id: 'boot-1' }))
  const ack = await next()
  assert.equal(ack.type, 'HelloAck')
  ws.send(
    JSON.stringify({
      type: 'MachineReport',
      total_memory: 32 * GIB,
      available_memory: 16 * GIB,
      commit_total: 8 * GIB,
      commit_limit: 64 * GIB,
      cpu_percent: 3,
      memory_pressure: 'normal',
      running: 0,
      executor_private_bytes: 18_000_000,
    }),
  )
  for (let i = 0; i < 200 && sessions.get(String(ack.machine_id))?.report === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  let seq = 0
  const event = async (body: Record<string, unknown>) => {
    seq += 1
    ws.send(JSON.stringify({ type: 'Event', seq, at: new Date().toISOString(), event: body }))
    assert.deepEqual(await next(), { type: 'Ack', seq })
  }
  return {
    next,
    event,
    close: () => ws.close(),
    /** Runs the Offer's command and ships its output, as the executor would; returns the offer and its lines. */
    async start(): Promise<Offer & { lines: string[] }> {
      const offer = (await next()) as unknown as Offer & Message
      assert.equal(offer.type, 'Offer')
      assert.equal(offer.job.program, process.execPath)
      const { stdout } = await run(offer.job.program, offer.job.args)
      const lines = stdout.split('\n').filter((line) => line !== '')
      await event({ kind: 'Admitted', run: offer.run })
      await event({
        kind: 'RunStarted',
        run: offer.run,
        pid: 4321,
        start_time: '134077128011234567',
        boot_id: 'boot-1',
      })
      if (lines.length > 0) {
        const at = Date.now()
        const json = lines.map((text, i) =>
          JSON.stringify({ seq: i + 1, timestamp_ms: at + i * 250, text, level: null }),
        )
        const zstd_base64 = zstdCompressSync(Buffer.from(`${json.join('\n')}\n`)).toString('base64')
        const segment = { first_seq: 1, last_seq: lines.length, records: lines.length, zstd_base64 }
        await event({ kind: 'LogSegment', run: offer.run, ...segment })
        // A resent segment adds no event twice.
        await event({ kind: 'LogSegment', run: offer.run, ...segment })
      }
      return { ...offer, lines }
    },
    finish: (runId: string, reason = 'exited', summary: string | null = null) =>
      event({
        kind: 'RunFinished',
        run: runId,
        reason,
        exit_code: reason === 'exited' ? 0 : null,
        peak: 1,
        p95: 1,
        p50: 1,
        cpu_seconds: 1,
        swept: 0,
        visible_windows: 0,
        tail: [],
        summary,
      }),
  }
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]

test('a fake agent runs as an agent job; its reported done label finishes the run with usage, cost and events', async () => {
  const { ctx, agentCtx, machine, enqueue } = await setup()
  const exec = await executor(machine.token)
  const queued = await enqueue('ship it')
  const offer = await exec.start()
  assert.equal(offer.run, queued.id)
  // The provider's flags after the job type's own args; the job's input became the prompt.
  assert.deepEqual(offer.job.args.slice(0, 6), [
    FAKE_AGENT,
    '-p',
    'ship it',
    '--output-format',
    'stream-json',
    '--verbose',
  ])
  assert.equal(offer.job.stall_s, 900)
  assert.equal(offer.job.env_set.DEVROUNDS_PROJECT, projectKey)
  const sessionId = flag(offer.job.args, '--session-id')

  await reportResult(agentCtx, projectKey, queued.id, { label: 'shipped', data: { pr: 42 } })
  await assert.rejects(reportResult(agentCtx, projectKey, queued.id, { label: 'shipped', data: {} }), code('DR353'))
  await exec.finish(queued.id)

  const view = await runView(ctx, queued.id)
  assert.equal(view.state, 'finished')
  assert.deepEqual(view.agent, {
    sessionId,
    resumedFrom: null,
    // The result line's totals win over the per-message usage.
    usage: { source: 'result', tokensIn: 50, tokensOut: 12, cacheRead: 100, cacheWrite: 10, costUsd: 0.0123 },
    result: { label: 'shipped', data: { pr: 42 } },
  })
  const events = await t.admin
    .selectFrom('agent_events')
    .select(['kind', 'data'])
    .where('run_id', '=', queued.id)
    .orderBy('line_seq')
    .orderBy('position')
    .execute()
  assert.deepEqual(
    events.map((event) => event.kind),
    ['message', 'usage', 'tool_call', 'usage', 'tool_result', 'message', 'usage', 'permission_request', 'result'],
  )
  const toolResult = events.find((event) => event.kind === 'tool_result')?.data as Record<string, unknown>
  assert.deepEqual(toolResult, { call: 'toolu_1', status: 'ok', name: 'Bash', duration_ms: 250 })
  // Never a tool's input or output, and for a reported result not the final answer either.
  assert.doesNotMatch(JSON.stringify(events), /SECRET|ship it/)
  exec.close()
})

test('a park label fails the run as parked, and no report at all ends it no_outcome', async () => {
  const { ctx, agentCtx, machine, enqueue } = await setup()
  const exec = await executor(machine.token)
  const parked = await enqueue('park me')
  await exec.start()
  await reportResult(agentCtx, projectKey, parked.id, { label: 'needs_human', data: {} })
  await exec.finish(parked.id)
  const parkedView = await runView(ctx, parked.id)
  assert.equal(parkedView.state, 'failed')
  assert.equal(parkedView.outcome.failureSummary, 'parked: needs_human')

  const silent = await enqueue('ship it')
  await exec.start()
  // Exit 0 does not finish a reported-result run on its own.
  await exec.finish(silent.id)
  const view = await runView(ctx, silent.id)
  assert.equal(view.state, 'failed')
  assert.equal(view.outcome.failureClass, 'no_outcome')
  // Ended: a late report is refused.
  await assert.rejects(reportResult(agentCtx, projectKey, silent.id, { label: 'shipped', data: {} }), code('DR351'))
  exec.close()
})

test('silence ends stalled with the last agent event in the summary; a runtime limit ends limit', async () => {
  const { ctx, machine, enqueue } = await setup()
  const exec = await executor(machine.token)
  const stalled = await enqueue('no-result')
  await exec.start()
  await exec.finish(stalled.id, 'stalled', 'DR154 {"stall_s":900}')
  const view = await runView(ctx, stalled.id)
  assert.equal(view.outcome.failureClass, 'stalled')
  assert.match(view.outcome.failureSummary ?? '', /last agent event: usage/)

  const limited = await enqueue('limit')
  await exec.start()
  await exec.finish(limited.id)
  assert.equal((await runView(ctx, limited.id)).outcome.failureClass, 'limit')
  exec.close()
})

test('without a result line, usage comes from the transcript, each message counted once', async () => {
  const { ctx, machine, enqueue } = await setup()
  const exec = await executor(machine.token)
  const queued = await enqueue('no-result')
  await exec.start()
  await exec.finish(queued.id)
  const view = await runView(ctx, queued.id)
  // msg_1 (20 in, 5 out) is on two lines, msg_2 (30, 7) on one.
  assert.deepEqual(view.agent?.usage, {
    source: 'transcript',
    tokensIn: 50,
    tokensOut: 12,
    cacheRead: 200,
    cacheWrite: 20,
    costUsd: null,
  })
  exec.close()
})

test("a text result is the runtime's final answer", async () => {
  const { ctx, machine, enqueue } = await setup()
  await putJobType(ctx, projectKey, agentType('answer', { result: { kind: 'text' } }))
  const exec = await executor(machine.token)
  const queued = await enqueue('forty-two', 'answer')
  await exec.start()
  await exec.finish(queued.id)
  const view = await runView(ctx, queued.id)
  assert.equal(view.state, 'finished')
  assert.deepEqual(view.agent?.result, { label: 'text', data: { text: 'forty-two' } })
  exec.close()
})

test('a spent daily budget keeps the next agent run queued with reason budget, while other runs go on', async () => {
  const { ctx, agentCtx, machine, enqueue } = await setup()
  await putJobType(ctx, projectKey, { key: 'check', command: { program: process.execPath, args: ['-v'] } })
  await setBudget(ctx, { projectKey, jobType: 'work', usdPerDay: 0.01, tokensPerDay: null, usdPerRun: 0.5 })
  const exec = await executor(machine.token)
  const first = await enqueue('ship it')
  const offer = await exec.start()
  // The per-run cap reaches the runtime.
  assert.equal(flag(offer.job.args, '--max-budget-usd'), '0.5')
  await reportResult(agentCtx, projectKey, first.id, { label: 'shipped', data: {} })
  await exec.finish(first.id)

  // 0.0123 spent of 0.01.
  const held = await enqueue('ship it again')
  const plain = await enqueueRun(ctx, { projectKey, jobTypeKey: 'check', cwd: 'C:\\work' })
  // Placement goes oldest first, so the plain run's Offer means the agent run was passed over.
  assert.equal((await exec.next()).run, plain.id)
  assert.equal((await runView(ctx, held.id)).state, 'queued')
  assert.deepEqual((await unplacedReasons(ctx, sessions, [held.id])).get(held.id), { reason: 'budget' })
  exec.close()
})

test("a retry resumes the session its run left, on the run's machine, up to resume.max", async () => {
  const { ctx, machine, enqueue } = await setup()
  await putJobType(
    ctx,
    projectKey,
    agentType('work', { resume: { max: 1 } }, { retry: { max_attempts: 3, backoff_s: 0, on: ['no_outcome'] } }),
  )
  const exec = await executor(machine.token)
  const first = await enqueue('no-result')
  const firstOffer = await exec.start()
  const sessionId = flag(firstOffer.job.args, '--session-id')
  await exec.finish(first.id)

  const second = await exec.start()
  assert.equal(flag(second.job.args, '--resume'), sessionId)
  assert.equal(second.job.args.includes('--session-id'), false)
  // The fake agent echoes the session it was given.
  assert.match(second.lines[0], new RegExp(`"session_id":"${sessionId}","resumed":true`))
  await exec.finish(second.run)
  const resumed = await runView(ctx, second.run)
  assert.equal(resumed.agent?.sessionId, sessionId)
  assert.equal(resumed.agent?.resumedFrom, first.id)
  const pinned = await t.admin
    .selectFrom('runs')
    .select('pinned_machine_id')
    .where('id', '=', second.run)
    .executeTakeFirst()
  assert.equal(pinned?.pinned_machine_id, machine.machineId)

  // resume.max reached: the third attempt is a new session.
  const third = await exec.start()
  assert.notEqual(flag(third.job.args, '--session-id'), sessionId)
  await exec.finish(third.run)
  assert.equal((await waitForRun(ctx, third.run, 0)).outcome.failureClass, 'no_outcome')
  exec.close()
})
