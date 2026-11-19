import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fail } from './errors/error.ts'

// appPassword is the devrounds_app password written by `devrounds-admin init`; migrations set it on the role.
// logsRoot holds the run log segments (runs/log-store.ts); they are pruned logRetentionDays after they arrive.
// otlpEndpoint turns the OpenTelemetry exporter on (telemetry/otel.ts); without it nothing of OpenTelemetry loads.
// schedulerPollS is how often the scheduler looks at every tenant without a wake (scheduler/scheduler.ts);
// offerTimeoutS is how long an executor has to answer an Offer.
// authSecret signs the session cookies (auth/session.ts); `devrounds-admin migrate` writes it, and without it `serve`
// runs with session login off.
export type Config = {
  databaseUrl: string
  adminDatabaseUrl: string
  port: number
  logsRoot: string
  logRetentionDays: number
  schedulerPollS: number
  offerTimeoutS: number
  otlpEndpoint?: string
  authSecret?: string
  appPassword?: string
}

const DEFAULT_PORT = 4992
const DEFAULT_LOG_RETENTION_DAYS = 14
const DEFAULT_SCHEDULER_POLL_S = 15
const DEFAULT_OFFER_TIMEOUT_S = 120
// Below this an executor busy with a burst of events could miss offers it was about to take.
const MIN_OFFER_TIMEOUT_S = 5
const MIN_AUTH_SECRET_LENGTH = 32

export function defaultLogsRoot(): string {
  return join(homedir(), '.devrounds', 'logs')
}

export function configPath(): string {
  return join(homedir(), '.devrounds', 'server.json')
}

async function readConfigFile(path: string): Promise<Partial<Config>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // A missing file is fine when the env vars cover every field; the checks below decide.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(text) as Partial<Config>
  } catch {
    return fail('DR502', { reason: `${path} is not valid JSON` })
  }
}

export type ServerConfig = Pick<
  Config,
  | 'databaseUrl'
  | 'port'
  | 'logsRoot'
  | 'logRetentionDays'
  | 'schedulerPollS'
  | 'offerTimeoutS'
  | 'otlpEndpoint'
  | 'authSecret'
>

function serverFields(env: NodeJS.ProcessEnv, file: Partial<Config>): ServerConfig {
  const databaseUrl = env.DEVROUNDS_DATABASE_URL ?? file.databaseUrl
  const port = Number(env.DEVROUNDS_PORT ?? file.port ?? DEFAULT_PORT)
  const logsRoot = env.DEVROUNDS_LOGS_ROOT ?? file.logsRoot ?? defaultLogsRoot()
  const logRetentionDays = Number(
    env.DEVROUNDS_LOG_RETENTION_DAYS ?? file.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
  )
  if (typeof databaseUrl !== 'string' || databaseUrl === '') fail('DR502', { reason: 'databaseUrl is not set' })
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('DR502', { reason: 'port must be 1-65535' })
  if (typeof logsRoot !== 'string' || logsRoot === '') fail('DR502', { reason: 'logsRoot must be a directory path' })
  if (!Number.isFinite(logRetentionDays) || logRetentionDays <= 0) {
    fail('DR502', { reason: 'logRetentionDays must be a number of days above 0' })
  }
  const schedulerPollS = Number(env.DEVROUNDS_SCHEDULER_POLL_S ?? file.schedulerPollS ?? DEFAULT_SCHEDULER_POLL_S)
  if (!Number.isFinite(schedulerPollS) || schedulerPollS <= 0) {
    fail('DR502', { reason: 'schedulerPollS must be a number of seconds above 0' })
  }
  const offerTimeoutS = Number(env.DEVROUNDS_OFFER_TIMEOUT_S ?? file.offerTimeoutS ?? DEFAULT_OFFER_TIMEOUT_S)
  // Whole seconds: claim_run takes an int.
  if (!Number.isInteger(offerTimeoutS) || offerTimeoutS < MIN_OFFER_TIMEOUT_S) {
    fail('DR502', { reason: `offerTimeoutS must be whole seconds >= ${MIN_OFFER_TIMEOUT_S}` })
  }
  const fields: ServerConfig = { databaseUrl, port, logsRoot, logRetentionDays, schedulerPollS, offerTimeoutS }
  const authSecret = env.DEVROUNDS_AUTH_SECRET ?? file.authSecret
  if (authSecret !== undefined && authSecret !== '') {
    // Better Auth only warns about a shorter secret; refuse it here instead. migrate writes 43 characters.
    if (typeof authSecret !== 'string' || authSecret.length < MIN_AUTH_SECRET_LENGTH) {
      fail('DR502', { reason: `authSecret must be at least ${MIN_AUTH_SECRET_LENGTH} characters` })
    }
    fields.authSecret = authSecret
  }
  const otlpEndpoint = env.DEVROUNDS_OTLP_ENDPOINT ?? file.otlpEndpoint
  if (otlpEndpoint === undefined || otlpEndpoint === '') return fields
  const protocol = typeof otlpEndpoint === 'string' ? URL.parse(otlpEndpoint)?.protocol : undefined
  if (protocol !== 'http:' && protocol !== 'https:') {
    fail('DR502', { reason: 'otlpEndpoint must be an http:// or https:// URL' })
  }
  return { ...fields, otlpEndpoint }
}

// What `serve` loads: the server never holds owner credentials, so the admin URL and app password are neither
// required nor returned (the parsed file is dropped right here).
export async function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  path = configPath(),
): Promise<ServerConfig> {
  return serverFields(env, await readConfigFile(path))
}

// Admin commands only. Env vars override the file field by field.
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, path = configPath()): Promise<Config> {
  const file = await readConfigFile(path)
  const adminDatabaseUrl = env.DEVROUNDS_ADMIN_DATABASE_URL ?? file.adminDatabaseUrl
  if (typeof adminDatabaseUrl !== 'string' || adminDatabaseUrl === '') {
    fail('DR502', { reason: 'adminDatabaseUrl is not set' })
  }
  const config: Config = { ...serverFields(env, file), adminDatabaseUrl }
  if (typeof file.appPassword === 'string') config.appPassword = file.appPassword
  return config
}
