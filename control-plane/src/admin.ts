#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { type Kysely, sql } from 'kysely'
import { issueToken, issueTokenIn, revokeToken } from './auth/tokens.ts'
import { type Config, configPath, loadConfig } from './config.ts'
import { toDevRoundsError } from './convert-error.ts'
import { createDb } from './db/connection.ts'
import { migrateToLatest } from './db/migrate.ts'
import type { Database } from './db/schema.ts'
import { explain, fail } from './errors/error.ts'
import { createProject } from './planning/service.ts'
import { withTenant } from './tenancy/scope.ts'

// devrounds-admin: operator commands. Every command except `init` connects with the owner URL from the config.

const APP_ROLE = 'devrounds_app'
const IMPORT_MEMBER = 'import'

const USAGE = `usage: devrounds-admin <command>

  init [--force]                     write ~/.devrounds/server.json with a new app password
  migrate                            migrate the database and set the ${APP_ROLE} password
  bootstrap --tenant <name> --project <key> --name <project name> --human <name>
                                     create a tenant, its members and project; prints a token once
  token create --tenant <name> --member <name> --kind human|agent
                                     prints a new token once (creates the member if missing)
  token revoke <id>                  revoke a token by id`

const run = promisify(execFile)

// Owner-only: the file holds both the owner and the app password. POSIX gets mode 600; on Windows mode bits do
// nothing, so icacls drops inherited entries and grants only the current user.
async function restrictToOwner(path: string): Promise<void> {
  if (process.platform !== 'win32') return chmod(path, 0o600)
  const domain = process.env.USERDOMAIN
  const user = domain ? `${domain}\\${userInfo().username}` : userInfo().username
  await run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`])
}

export async function initConfig(path: string, opts: { force: boolean }): Promise<Config> {
  const appPassword = randomBytes(24).toString('base64url')
  const config: Config = {
    databaseUrl: `postgres://${APP_ROLE}:${appPassword}@127.0.0.1:15433/devrounds`,
    adminDatabaseUrl: 'postgres://postgres:postgres@127.0.0.1:15433/devrounds',
    port: 4992,
    appPassword,
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // 'wx' makes "already exists" atomic with the create, so two inits cannot both write.
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: opts.force ? 'w' : 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      fail('DR101', { path, reason: 'the file already exists; pass --force to replace it' })
    }
    throw err
  }
  try {
    await restrictToOwner(path)
  } catch (err) {
    // The file holds passwords: never leave it readable by others because the permission step failed.
    await rm(path, { force: true })
    throw err
  }
  return config
}

async function tenantIdByName(admin: Kysely<Database>, name: string): Promise<string> {
  const rows = await admin.selectFrom('tenants').select('id').where('name', '=', name).execute()
  if (rows.length > 1) fail('DR101', { path: '--tenant', reason: `${rows.length} tenants are named ${name}` })
  return rows[0]?.id ?? fail('DR201', { kind: 'tenant', key: name })
}

export async function bootstrap(
  admin: Kysely<Database>,
  appRole: string,
  i: { tenant: string; project: string; name: string; human: string },
): Promise<{ id: string; token: string }> {
  const existing = await admin.selectFrom('tenants').select('id').where('name', '=', i.tenant).executeTakeFirst()
  if (existing) fail('DR101', { path: '--tenant', reason: `tenant ${i.tenant} already exists` })
  // The id is chosen here so the tenant row, its members, the project and the token share one tenant-scoped
  // transaction: a failed bootstrap leaves nothing behind and can simply run again.
  const tenantId = randomUUID()
  return withTenant(admin, tenantId, async (trx) => {
    // A superuser skips RLS even when it is forced, and the planning service finds keys through RLS alone (its
    // lookups carry no tenant filter), so on the owner connection it would see other tenants' projects. Acting as
    // the app role for this transaction puts the policies back. The role stays on for the token too: the app role
    // has DML on api_tokens, and the insert passes the same tenant policy.
    await sql`set local role ${sql.id(appRole)}`.execute(trx)
    await trx.insertInto('tenants').values({ id: tenantId, name: i.tenant }).execute()
    const [human] = await trx
      .insertInto('members')
      .values([
        { tenant_id: tenantId, kind: 'human', name: i.human },
        { tenant_id: tenantId, kind: 'agent', name: IMPORT_MEMBER },
      ])
      .returning(['id', 'kind'])
      .execute()
    await createProject({ db: admin, tenantId, actor: human, trx }, { key: i.project, name: i.name })
    return issueTokenIn(trx, tenantId, i.human, 'human')
  })
}

function printToken(issued: { id: string; token: string }): void {
  console.log(`token (shown once): ${issued.token}\nid (for token revoke): ${issued.id}`)
}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name]
  if (typeof value !== 'string' || value === '') fail('DR101', { path: `--${name}`, reason: 'is required' })
  return value
}

async function withAdminDb<T>(fn: (admin: Kysely<Database>) => Promise<T>): Promise<T> {
  const config = await loadConfig()
  const admin = createDb(config.adminDatabaseUrl)
  try {
    return await fn(admin)
  } finally {
    await admin.destroy()
  }
}

function parseArgv(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        force: { type: 'boolean' },
        tenant: { type: 'string' },
        project: { type: 'string' },
        name: { type: 'string' },
        human: { type: 'string' },
        member: { type: 'string' },
        kind: { type: 'string' },
        help: { type: 'boolean' },
      },
    })
  } catch (err) {
    return fail('DR101', { path: 'arguments', reason: (err as Error).message })
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgv(argv)
  const command = positionals.join(' ')
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (command === 'init') {
    const path = configPath()
    await initConfig(path, { force: values.force === true })
    console.log(`wrote ${path}\nnext: devrounds-admin migrate`)
    return 0
  }
  if (command === 'migrate') {
    const config = await loadConfig()
    await migrateToLatest(config.adminDatabaseUrl, { appRole: APP_ROLE, appPassword: config.appPassword })
    console.log('database is up to date')
    return 0
  }
  if (command === 'bootstrap') {
    const issued = await withAdminDb((admin) =>
      bootstrap(admin, APP_ROLE, {
        tenant: required(values, 'tenant'),
        project: required(values, 'project'),
        name: required(values, 'name'),
        human: required(values, 'human'),
      }),
    )
    printToken(issued)
    return 0
  }
  if (command === 'token create') {
    const kind = required(values, 'kind')
    if (kind !== 'human' && kind !== 'agent') fail('DR101', { path: '--kind', reason: 'must be human or agent' })
    const issued = await withAdminDb(async (admin) =>
      issueToken(admin, await tenantIdByName(admin, required(values, 'tenant')), required(values, 'member'), kind),
    )
    printToken(issued)
    return 0
  }
  if (positionals[0] === 'token' && positionals[1] === 'revoke' && positionals.length === 3) {
    await withAdminDb((admin) => revokeToken(admin, positionals[2]))
    console.log(`revoked ${positionals[2]}`)
    return 0
  }
  console.error(USAGE)
  return 2
}

// The operator is local and owns the database, so an internal error prints its cause here (the API never does).
async function cli(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (err) {
    const error = toDevRoundsError(err)
    const { text, hint, exitCode } = explain(error.code, error.data)
    console.error(`${error.code}: ${text}\n${hint}`)
    if (error.code === 'DR501') console.error(String(error.data.cause))
    process.exitCode = exitCode
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli()
