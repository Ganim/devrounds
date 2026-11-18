import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Value } from '@sinclair/typebox/value'
import { DevRoundsError } from '../errors/error.ts'
import { EXECUTOR } from '../test-support/rust-files.ts'
import {
  CONTROL_PLANE_MESSAGES,
  checkHello,
  EXECUTOR_MESSAGES,
  FEATURES,
  type Hello,
  negotiate,
  parseExecutorMessage,
  RUN_EVENTS,
  SeqTracker,
} from './protocol.ts'

// The Rust crate owns the fixtures; both sides test against the same files.
const FIXTURES = join(EXECUTOR, 'crates', 'protocol', 'fixtures')

async function fixtures(): Promise<Map<string, unknown>> {
  const all = new Map<string, unknown>()
  for (const file of await readdir(FIXTURES)) {
    all.set(file.replace(/\.json$/, ''), JSON.parse(await readFile(join(FIXTURES, file), 'utf8')))
  }
  return all
}

function schemaFor(name: string) {
  const [type] = name.split('.')
  if (type in EXECUTOR_MESSAGES) return EXECUTOR_MESSAGES[type as keyof typeof EXECUTOR_MESSAGES]
  return CONTROL_PLANE_MESSAGES[type as keyof typeof CONTROL_PLANE_MESSAGES]
}

const DR150 = (path: string) => (err: unknown) =>
  err instanceof DevRoundsError && err.code === 'DR150' && err.data.path === path

test('every fixture validates against the TypeBox schema', async () => {
  const all = await fixtures()
  const expected = [
    ...Object.keys(EXECUTOR_MESSAGES).filter((type) => type !== 'Event'),
    ...Object.keys(RUN_EVENTS).map((kind) => `Event.${kind}`),
    ...Object.keys(CONTROL_PLANE_MESSAGES),
  ].sort()
  assert.deepEqual([...all.keys()].sort(), expected)
  for (const [name, message] of all) {
    const schema = schemaFor(name)
    assert.ok(Value.Check(schema, message), `${name}: ${JSON.stringify([...Value.Errors(schema, message)][0])}`)
    if (name in CONTROL_PLANE_MESSAGES) continue
    assert.deepEqual(parseExecutorMessage(JSON.stringify(message)), message, name)
  }
})

test('a known type with a bad field answers DR150 at its path', async () => {
  const all = await fixtures()
  const report = { ...(all.get('MachineReport') as object), running: 1.5 }
  assert.throws(() => parseExecutorMessage(JSON.stringify(report)), DR150('/running'))
  const finished = all.get('Event.RunFinished') as { event: object }
  const badReason = { ...finished, event: { ...finished.event, reason: 'crashed' } }
  assert.throws(() => parseExecutorMessage(JSON.stringify(badReason)), DR150('/event/reason'))
  const unsafeSeq = { ...finished, seq: Number.MAX_SAFE_INTEGER + 2 }
  assert.throws(() => parseExecutorMessage(JSON.stringify(unsafeSeq)), DR150('/seq'))
  assert.throws(() => parseExecutorMessage('{"seq":1}'), DR150('/type'))
  assert.throws(() => parseExecutorMessage('not json'), DR150('/'))
})

test('an unknown type parses as Unknown', () => {
  assert.deepEqual(parseExecutorMessage('{"type":"Telemetry","spans":[]}'), { type: 'Unknown' })
  const event = parseExecutorMessage(
    '{"type":"Event","seq":9,"at":"2026-11-18T12:00:00Z","event":{"kind":"Paused","run":"r"}}',
  )
  assert.deepEqual(event, { type: 'Event', seq: 9, at: '2026-11-18T12:00:00Z', event: { kind: 'Unknown' } })
})

test('checkHello negotiates features and answers DR151 for another protocol', async () => {
  const hello = (await fixtures()).get('Hello') as Hello
  assert.deepEqual(checkHello({ ...hello, features: ['orphans', 'seq', 'telepathy'] }), ['seq', 'orphans'])
  assert.deepEqual(checkHello(hello), [...FEATURES])
  assert.throws(
    () => checkHello({ ...hello, protocol: 2 }),
    (err) => err instanceof DevRoundsError && err.code === 'DR151' && err.data.got === 2,
  )
  assert.deepEqual(negotiate(['a', 'b'], []), [])
})

test('SeqTracker answers new, duplicate and one gap', () => {
  const seq = new SeqTracker(2n)
  assert.equal(seq.accept(2), 'duplicate')
  assert.equal(seq.accept(3), 'new')
  assert.equal(seq.lastSeq, 3n)
  assert.equal(seq.accept(5), 'gap')
  assert.equal(seq.accept(6), 'duplicate', 'one Resync per gap')
  assert.equal(seq.lastSeq, 3n)
  assert.equal(seq.accept(4), 'new')
  assert.equal(seq.accept(5), 'new')
  assert.equal(seq.accept(8), 'gap', 'a later gap answers again')
})
