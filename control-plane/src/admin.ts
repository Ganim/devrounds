#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { type Kysely, sql } from 'kysely'
import { createUser } from './auth/session.ts'
import { issueToken, issueTokenIn, revokeToken } from './auth/tokens.ts'
import { type Config, configPath, defaultLogsRoot, loadConfig } from './config.ts'
import { toDevRoundsError } from './convert-error.ts'
import { createDb } from './db/connection.ts'
import { migrateToLatest } from './db/migrate.ts'
import type { Database } from './db/schema.ts'
import { explain, fail } from './errors/error.ts'
import { isMain } from './is-main.ts'
import { restrictToOwner } from './owner-only.ts'
import { createProject } from './planning/service.ts'
import { installService, TASK_NAME, uninstallService } from './service/install.ts'
import { withTenant } from './tenancy/scope.ts'

// devrounds-admin: operator commands. Every command except `init` and `service` connects with the owner URL from the
// config.

const APP_ROLE = 'devrounds_app'
const IMPORT_MEMBER = 'import'

const USAGE = `usage: devrounds-admin <command>

  init [--force]                     write ~/.devrounds/server.json with a new app password
  migrate                            migrate the database, set the ${APP_ROLE} password and add authSecret
  bootstrap --tenant <name> --project <key> --name <project name> --human <name>
                                     create a tenant, its members and project; prints a token once
  project add --tenant <name> --key <key> --name <project name>
                                     add a project to an existing tenant
  token create --tenant <name> --member <name> --kind human|agent
                                     prints a new token once (creates the member if missing)
  token revoke <id>                  revoke a token by id
  login create --tenant <name> --member <name> --email <email>
                                     give a human member a web login; prints its password once
  login remove --tenant <name> --member <name>
                                     delete the member's web login and its sessions
  service install                    run the control plane as the ${TASK_NAME} scheduled task (Windows) and start it
  service uninstall                  stop and remove the ${TASK_NAME} scheduled task`

// The scheduler settings stay out of the file: their defaults apply until someone sets them.
type InitialConfig = Omit<Config, 'schedulerPollS' | 'offerTimeoutS'>

export async function initConfig(path: string, opts: { force: boolean }): Promise<InitialConfig> {
  const appPassword = randomBytes(24).toString('base64url')
  const config: InitialConfig = {
    databaseUrl: `postgres://${APP_ROLE}:${appPassword}@127.0.0.1:15433/devrounds`,
    adminDatabaseUrl: 'postgres://postgres:postgres@127.0.0.1:15433/devrounds',
    port: 4992,
    logsRoot: defaultLogsRoot(),
    logRetentionDays: 14,
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
  const taken = { path: '--tenant', reason: `tenant ${i.tenant} already exists` }
  const existing = await admin.selectFrom('tenants').select('id').where('name', '=', i.tenant).executeTakeFirst()
  if (existing) fail('DR101', taken)
  // The id is chosen here so the tenant row, its members, the project and the token share one tenant-scoped
  // transaction: a failed bootstrap leaves nothing behind and can simply run again.
  const tenantId = randomUUID()
  return withTenant(admin, tenantId, async (trx) => {
    // A superuser skips RLS even when it is forced, and the planning service finds keys through RLS alone (its
    // lookups carry no tenant filter), so on the owner connection it would see other tenants' projects. Acting as
    // the app role for this transaction puts the policies back. The role stays on for the token too: the app role
    // has DML on api_tokens, and the insert passes the same tenant policy.
    await sql`set local role ${sql.id(appRole)}`.execute(trx)
    // A bootstrap of the same name running at once passes the check above too; the unique name (0028) makes this
    // insert wait for it and fail if it commits.
    try {
      await trx.insertInto('tenants').values({ id: tenantId, name: i.tenant }).execute()
    } catch (err) {
      if ((err as { constraint?: unknown } | null)?.constraint === 'tenants_name_key') fail('DR101', taken)
      throw err
    }
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

// A second project in an existing tenant. Same shape as bootstrap: the app role is on for the transaction so the
// planning service sees only this tenant's keys, and the event is recorded by the `import` member.
export async function projectAdd(
  admin: Kysely<Database>,
  appRole: string,
  i: { tenant: string; key: string; name: string },
): Promise<{ projectId: string; eventId: string }> {
  const tenantId = await tenantIdByName(admin, i.tenant)
  return withTenant(admin, tenantId, async (trx) => {
    await sql`set local role ${sql.id(appRole)}`.execute(trx)
    const actor = await trx
      .selectFrom('members')
      .select(['id', 'kind'])
      .where('name', '=', IMPORT_MEMBER)
      .executeTakeFirstOrThrow()
    return createProject({ db: admin, tenantId, actor, trx }, { key: i.key, name: i.name })
  })
}

// Adds a new authSecret to the config file, keeping its other fields. Never replaces one: a new secret would sign
// every browser out.
async function writeAuthSecret(path: string): Promise<string> {
  const authSecret = randomBytes(32).toString('base64url')
  let file: object = {}
  try {
    file = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    // Env vars alone may configure the admin; the secret then starts the file.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify({ ...file, authSecret }, null, 2)}\n`, { mode: 0o600 })
  await restrictToOwner(path)
  return authSecret
}

// `devrounds-admin migrate`: ours, then Better Auth's tables (they need the secret, written first when missing).
export async function migrate(path: string, appRole: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await loadConfig(env, path)
  const authSecret = config.authSecret ?? (await writeAuthSecret(path))
  await migrateToLatest(config.adminDatabaseUrl, { appRole, appPassword: config.appPassword, authSecret })
}

export type LoginAccess = { adminUrl: string; secret: string; port: number }

// Read as the owner with an explicit tenant filter (the owner skips RLS).
async function memberByName(admin: Kysely<Database>, tenant: string, name: string) {
  const tenantId = await tenantIdByName(admin, tenant)
  const member = await admin
    .selectFrom('members')
    .select(['id', 'tenant_id', 'kind', 'user_id'])
    .where('tenant_id', '=', tenantId)
    .where('name', '=', name)
    .executeTakeFirst()
  return member ?? fail('DR201', { kind: 'member', key: name })
}

// Better Auth's own rows of a user. Raw SQL on purpose: the admin removes a login without loading Better Auth.
async function deleteUser(db: Kysely<Database>, userId: string): Promise<void> {
  await sql`delete from auth.session where "userId" = ${userId}`.execute(db)
  await sql`delete from auth.account where "userId" = ${userId}`.execute(db)
  await sql`delete from auth."user" where id = ${userId}`.execute(db)
}

const ALREADY_LINKED = { path: '--member', reason: 'already has a login; remove it first' }

// Gives a human member a web login (email + a generated password) and returns the password, shown once. The user is
// created through Better Auth, which hashes the password its own way; if linking the member then fails, the user goes.
export async function createLogin(
  admin: Kysely<Database>,
  access: LoginAccess,
  i: { tenant: string; member: string; email: string },
): Promise<string> {
  const member = await memberByName(admin, i.tenant, i.member)
  if (member.kind !== 'human') fail('DR453', { action: 'log in' })
  if (member.user_id !== null) fail('DR101', ALREADY_LINKED)
  // 15 bytes are exactly 20 base64url characters.
  const password = randomBytes(15).toString('base64url')
  const auth = { databaseUrl: access.adminUrl, port: access.port, secret: access.secret }
  const userId = await createUser(auth, { email: i.email, password })
  try {
    await admin.transaction().execute(async (trx) => {
      // Sign-up signs the new user in; nobody holds that session's token.
      await sql`delete from auth.session where "userId" = ${userId}`.execute(trx)
      const linked = await trx
        .updateTable('members')
        .set({ user_id: userId })
        .where('tenant_id', '=', member.tenant_id)
        .where('id', '=', member.id)
        .where('user_id', 'is', null)
        .executeTakeFirst()
      // A concurrent login create won the race.
      if (linked.numUpdatedRows === 0n) fail('DR101', ALREADY_LINKED)
    })
  } catch (err) {
    await deleteUser(admin, userId)
    throw err
  }
  return password
}

// Deletes the member's Better Auth user (and with it every session) and unlinks the member, in one transaction.
export async function removeLogin(admin: Kysely<Database>, i: { tenant: string; member: string }): Promise<void> {
  const member = await memberByName(admin, i.tenant, i.member)
  const userId = member.user_id ?? fail('DR201', { kind: 'login', key: i.member })
  await admin.transaction().execute(async (trx) => {
    await trx
      .updateTable('members')
      .set({ user_id: null })
      .where('tenant_id', '=', member.tenant_id)
      .where('id', '=', member.id)
      .execute()
    await deleteUser(trx, userId)
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
        key: { type: 'string' },
        name: { type: 'string' },
        human: { type: 'string' },
        member: { type: 'string' },
        kind: { type: 'string' },
        email: { type: 'string' },
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
    await migrate(configPath(), APP_ROLE)
    console.log('database is up to date')
    return 0
  }
  if (command === 'login create') {
    const config = await loadConfig()
    const secret = config.authSecret ?? fail('DR502', { reason: 'authSecret is not set; run devrounds-admin migrate' })
    const access = { adminUrl: config.adminDatabaseUrl, secret, port: config.port }
    const email = required(values, 'email')
    const password = await withAdminDb((admin) =>
      createLogin(admin, access, { tenant: required(values, 'tenant'), member: required(values, 'member'), email }),
    )
    console.log(`password for ${email} (shown once): ${password}\nsign in at http://127.0.0.1:${config.port}/`)
    return 0
  }
  if (command === 'login remove') {
    const member = required(values, 'member')
    await withAdminDb((admin) => removeLogin(admin, { tenant: required(values, 'tenant'), member }))
    console.log(`removed the login of ${member}`)
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
  if (command === 'project add') {
    const added = await withAdminDb((admin) =>
      projectAdd(admin, APP_ROLE, {
        tenant: required(values, 'tenant'),
        key: required(values, 'key'),
        name: required(values, 'name'),
      }),
    )
    console.log(`project ${required(values, 'key')} created (${added.projectId})`)
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
  if (command === 'service install') {
    const target = await installService()
    console.log(`scheduled task ${TASK_NAME} registered and started\nnode: ${target.node}\nlogs: ~/.devrounds/logs/`)
    return 0
  }
  if (command === 'service uninstall') {
    await uninstallService()
    console.log(`scheduled task ${TASK_NAME} removed`)
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

if (await isMain(import.meta.url)) await cli()
