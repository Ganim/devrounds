import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../api/server.ts'
import { createToken } from '../auth/tokens.ts'
import { createProject } from '../planning/service.ts'
import { testDb } from '../test-support/db.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

let app: ReturnType<typeof buildServer>
let url: string

before(async () => {
  app = buildServer({ db: (await testDb()).db, logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

after(() => app.close())

// Runs the real bin in its own process, the way an agent calls it.
function cli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? Number(err.code) : 0, out: `${stdout}${stderr}` })
    })
  })
}

test('exit code 3 for a project of another tenant', async () => {
  const t = await testDb()
  const mine = await t.newTenant()
  await createProject({ db: t.db, tenantId: mine.tenantId, actor: mine.human }, { key: 'alpha', name: 'Alpha' })
  const other = await t.newTenant()
  await createProject({ db: t.db, tenantId: other.tenantId, actor: other.human }, { key: 'beta', name: 'Beta' })
  const token = await createToken(t.admin, mine.tenantId, 'human', 'human')

  const env = { DEVROUNDS_URL: url, DEVROUNDS_TOKEN: token }
  const own = await cli(['plan', 'show'], { ...env, DEVROUNDS_PROJECT: 'alpha' })
  assert.equal(own.code, 0, own.out)

  const res = await cli(['plan', 'show'], { ...env, DEVROUNDS_PROJECT: 'beta' })
  assert.equal(res.code, 3, res.out)
  assert.match(res.out, /^DR201 No project beta found\.\nhint: /)
  assert.match(res.out, /\nnext: [^\n]+\n$/)
})

test('exit code 4 when the control plane is unreachable', async () => {
  // A port that was just free: nothing listens there any more.
  const probe = buildServer({ db: (await testDb()).db, logger: false })
  await probe.listen({ port: 0, host: '127.0.0.1' })
  const closed = `http://127.0.0.1:${(probe.server.address() as AddressInfo).port}`
  await probe.close()

  const res = await cli(['plan', 'show'], { DEVROUNDS_URL: closed, DEVROUNDS_TOKEN: 'x', DEVROUNDS_PROJECT: 'alpha' })
  assert.equal(res.code, 4, res.out)
  assert.ok(res.out.startsWith(`control plane unreachable at ${closed}`), res.out)
})
