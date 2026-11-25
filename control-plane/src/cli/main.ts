#!/usr/bin/env node
import { defaultConfigPath, runCli } from './commands.ts'

// The `devrounds` bin. Everything testable lives in commands.ts; this file only wires the process to it.
// `devrounds plan show | head -1`: the reader may leave before the output is written. Nobody is left to read it, so
// the run ends with its own exit code instead of an unhandled EPIPE and a stack trace. Set before the command runs,
// since a wait writes its progress while it lasts.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit()
    throw err
  })
}
const { exitCode, stdout, stderr } = await runCli(process.argv.slice(2), {
  env: process.env,
  configPath: defaultConfigPath(),
  progress: (line) => process.stderr.write(`${line}\n`),
})
process.exitCode = exitCode
process.stdout.write(stdout)
process.stderr.write(stderr)
