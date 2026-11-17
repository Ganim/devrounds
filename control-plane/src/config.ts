import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fail } from './errors/error.ts'

// appPassword is the devrounds_app password written by `devrounds-admin init`; migrations set it on the role.
export type Config = { databaseUrl: string; adminDatabaseUrl: string; port: number; appPassword?: string }

const DEFAULT_PORT = 4992

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

export type ServerConfig = Pick<Config, 'databaseUrl' | 'port'>

function serverFields(env: NodeJS.ProcessEnv, file: Partial<Config>): ServerConfig {
  const databaseUrl = env.DEVROUNDS_DATABASE_URL ?? file.databaseUrl
  const port = Number(env.DEVROUNDS_PORT ?? file.port ?? DEFAULT_PORT)
  if (typeof databaseUrl !== 'string' || databaseUrl === '') fail('DR502', { reason: 'databaseUrl is not set' })
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('DR502', { reason: 'port must be 1-65535' })
  return { databaseUrl, port }
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
