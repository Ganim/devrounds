import type { EnvironmentReading } from '../executor/protocol.ts'
import { devlanes } from './devlanes.ts'
import type { Command, EnvironmentProvider, Lane } from './provider.ts'

// Provider keys a job type's `environment.provider` may name. A key, once shipped, is never removed: stored job types
// name it.
export const ENVIRONMENT_PROVIDERS: Record<string, EnvironmentProvider> = { devlanes }

export const ENVIRONMENT_MODES = ['with', 'status'] as const

// `with`: the run's command runs inside the cwd's environment (the provider's wrap) and its lane is read first.
// `status`: the command runs as is; the lane is only read.
export type JobTypeEnvironment = { provider: string; mode: (typeof ENVIRONMENT_MODES)[number] }

// What a run stores in runs.environment and GET /runs/:id shows. `lane` null with `error` saying why: the executor
// predates feature environment (no reading), the probe failed, or the cwd has no lane.
export type RunEnvironment = {
  provider: string
  mode: JobTypeEnvironment['mode']
  lane: Lane | null
  probeExitCode: number | null
  error: string | null
}

const providerOf = (environment: JobTypeEnvironment): EnvironmentProvider | undefined =>
  Object.hasOwn(ENVIRONMENT_PROVIDERS, environment.provider) ? ENVIRONMENT_PROVIDERS[environment.provider] : undefined

/** The command and probe an Offer carries for a job type with `environment` (null: none). */
export function environmentOffer(
  environment: JobTypeEnvironment | null,
  command: Command,
): { command: Command; probe?: Command } {
  const provider = environment && providerOf(environment)
  if (!environment || !provider) return { command }
  return { command: environment.mode === 'with' ? provider.wrap(command) : command, probe: provider.probe }
}

/** What a run stores of its RunStarted reading, for a job type with `environment`. */
export function runEnvironment(
  environment: JobTypeEnvironment,
  reading: EnvironmentReading | undefined,
): RunEnvironment {
  const base = { provider: environment.provider, mode: environment.mode, lane: null, probeExitCode: null }
  if (!reading) return { ...base, error: 'the executor read no environment (it predates feature environment)' }
  const probeExitCode = reading.exit_code
  const provider = providerOf(environment)
  if (reading.output === null || !provider) {
    return { ...base, probeExitCode, error: reading.error ?? `unknown provider ${environment.provider}` }
  }
  const found = provider.lane(reading.output)
  return 'lane' in found
    ? { ...base, probeExitCode, lane: found.lane, error: null }
    : { ...base, probeExitCode, error: found.error }
}
