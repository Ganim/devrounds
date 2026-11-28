// An environment provider: what a job type's `environment` names (job-types/file.ts). The core only asks a provider
// for these three things, so a provider is an adapter and the engine names none (MANIFESTO §4).

export type Command = { program: string; args: string[] }

// The cwd's environment as a provider reads it, bounded so a run row stays small: a reference to it, its state and the
// URLs of its units.
export type Lane = {
  reference: string
  branch: string | null
  path: string | null
  state: string
  units: { name: string; state: string; urls: string[] }[]
}

export type EnvironmentProvider = {
  // The command a run in mode `with` starts in place of `command`: the same command, inside the cwd's environment.
  wrap(command: Command): Command
  // Printed JSON describes the cwd's environment. The executor runs it in the run's cwd with the run's environment just
  // before the run starts (protocol feature environment), in both modes.
  probe: Command
  // The lane of the run's cwd in the probe's output, or why there is none.
  lane(output: unknown): { lane: Lane } | { error: string }
}
