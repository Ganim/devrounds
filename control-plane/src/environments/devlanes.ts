import type { EnvironmentProvider, Lane } from './provider.ts'

// devlanes runs one lane (ports, hostnames, env, containers) per git worktree. `devlanes with -- <command>` starts the
// cwd's lane, waits until it is ready, runs the command with the lane's env, stops what it started and exits with the
// command's code; DevRounds never starts or stops a lane itself. `devlanes status --json` lists the lanes of the cwd's
// project, `here` naming the cwd's (`here_error` when the cwd has none), and exits 1 while a lane has failed, still
// printing the list.

const MAX_UNITS = 100
const MAX_URLS = 10
const MAX_TEXT = 500

const text = (value: unknown): string | null => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : null)
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function laneOf(item: Record<string, unknown>, reference: string): Lane {
  return {
    reference,
    branch: text(item.branch),
    path: text(item.path),
    state: text(item.state) ?? 'unknown',
    units: list(item.units)
      .slice(0, MAX_UNITS)
      .map((unit) => {
        const u = record(unit)
        const urls = list(u.urls)
          .map(text)
          .filter((url) => url !== null)
        return { name: text(u.name) ?? '', state: text(u.state) ?? 'unknown', urls: urls.slice(0, MAX_URLS) }
      }),
  }
}

export const devlanes: EnvironmentProvider = {
  wrap: (command) => ({ program: 'devlanes', args: ['with', '--', command.program, ...command.args] }),
  probe: { program: 'devlanes', args: ['status', '--json'] },
  lane(output) {
    const status = record(output)
    const here = text(status.here)
    if (here === null) {
      const code = text(record(status.here_error).code) ?? 'unknown'
      return { error: `no lane for this directory (${code})` }
    }
    const item = list(status.items)
      .map(record)
      .find((candidate) => candidate.reference === here)
    return item ? { lane: laneOf(item, here) } : { error: `lane ${here} is not in the status output` }
  },
}
