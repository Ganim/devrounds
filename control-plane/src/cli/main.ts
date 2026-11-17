#!/usr/bin/env node
import { defaultConfigPath, runCli } from './commands.ts'

// The `devrounds` bin. Everything testable lives in commands.ts; this file only wires the process to it.
const { exitCode, stdout, stderr } = await runCli(process.argv.slice(2), {
  env: process.env,
  configPath: defaultConfigPath(),
})
process.stdout.write(stdout)
process.stderr.write(stderr)
process.exitCode = exitCode
