import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { FailureClass } from '../db/schema.ts'
import { FAILURE_CLASSES, RULE_CLASSES } from '../runs/classify.ts'
import { type Issue, parseYamlFile } from '../yaml-file.ts'

// A job type file, e.g. `devrounds jobtype set check.yaml`. Omitted fields take the defaults of the job_types columns.
const Key = Type.String({ minLength: 1, maxLength: 200 })
const OneOf = <T extends string[]>(...words: [...T]) => Type.Union(words.map((word) => Type.Literal(word)))

// Limits shared by a job's args and env (jobs/batch-file.ts, POST /runs).
export const EnvName = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,199}$' })
export const EnvValues = Type.Record(EnvName, Type.String({ maxLength: 4096 }), {
  maxProperties: 50,
  additionalProperties: false,
})
export const JobArgs = Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 200 })
// The executor sets it to the run's id (executor/crates/executor/src/isolation.rs); nothing else may.
const RUN_ID_VAR = 'DEVROUNDS_RUN_ID'

// Windows compares variable names ignoring case, so every check on names does too (names are ASCII by EnvName).
export const sameEnvName = (a: string, b: string) => a.toUpperCase() === b.toUpperCase()

const Rule = Type.Object(
  {
    class: OneOf(...RULE_CLASSES),
    // Up to u32: Windows reports NTSTATUS codes such as 3221225477 as unsigned.
    exit_codes: Type.Optional(Type.Array(Type.Integer({ minimum: -2147483648, maximum: 4294967295 }), { minItems: 1 })),
    log_pattern: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)

export const JobTypeFileSchema = Type.Object(
  {
    key: Key,
    command: Type.Object(
      { program: Type.String({ minLength: 1 }), args: Type.Optional(Type.Array(Type.String())) },
      { additionalProperties: false },
    ),
    // Names of the machine's environment variables the run may see; values never leave the machine.
    env: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    // A job may append arguments to command.args (its `args`).
    args_from_job: Type.Optional(Type.Boolean()),
    // Names a job may give values (its `env`), and values every run gets. Both are stored and sent to the machine, so
    // they carry names and flags, never secrets; a secret stays in the machine's environment behind `env`.
    job_env: Type.Optional(Type.Array(EnvName, { maxItems: 50 })),
    env_set: Type.Optional(EnvValues),
    timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
    orphan_policy: Type.Optional(OneOf('kill', 'let_finish')),
    classify: Type.Optional(Type.Array(Rule)),
    retry: Type.Optional(
      Type.Object(
        {
          max_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
          backoff_s: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
          on: Type.Optional(Type.Array(OneOf(...FAILURE_CLASSES))),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type JobTypeFile = Static<typeof JobTypeFileSchema>

/** A job type with every default filled in. */
export type JobTypeDef = {
  key: string
  command: { program: string; args: string[] }
  env: string[]
  timeout_s: number
  orphan_policy: 'kill' | 'let_finish'
  classify: Static<typeof Rule>[]
  retry: { max_attempts: number; backoff_s: number; on: FailureClass[] }
  args_from_job: boolean
  job_env: string[]
  env_set: Record<string, string>
}

// Schema first, then what a schema cannot say: a rule needs a condition (or it would swallow every failure), a
// pattern must compile, cancelled (a person stopped the run) is never retried, and the run id is the executor's.
export function findJobTypeIssue(value: unknown): Issue | null {
  const first = Value.Errors(JobTypeFileSchema, value).First()
  if (first) return { path: first.path || '/', reason: first.message }
  for (const [i, rule] of ((value as JobTypeFile).classify ?? []).entries()) {
    if (rule.exit_codes === undefined && rule.log_pattern === undefined) {
      return { path: `/classify/${i}`, reason: 'give exit_codes, log_pattern or both' }
    }
    if (rule.log_pattern !== undefined) {
      try {
        new RegExp(rule.log_pattern)
      } catch (err) {
        return { path: `/classify/${i}/log_pattern`, reason: (err as Error).message }
      }
    }
  }
  const file = value as JobTypeFile
  const isRunId = (name: string) => sameEnvName(name, RUN_ID_VAR)
  const named = Object.keys(file.env_set ?? {}).find(isRunId)
  if (named !== undefined) return { path: `/env_set/${named}`, reason: 'set by the executor' }
  const listed = (file.job_env ?? []).findIndex(isRunId)
  if (listed !== -1) return { path: `/job_env/${listed}`, reason: 'set by the executor' }
  const on = file.retry?.on ?? []
  const cancelled = on.indexOf('cancelled')
  if (cancelled !== -1) return { path: `/retry/on/${cancelled}`, reason: 'cancelled is never retried' }
  return null
}

export function withDefaults(file: JobTypeFile): JobTypeDef {
  return {
    key: file.key,
    command: { program: file.command.program, args: file.command.args ?? [] },
    env: file.env ?? [],
    timeout_s: file.timeout_s ?? 3600,
    orphan_policy: file.orphan_policy ?? 'kill',
    classify: file.classify ?? [],
    retry: {
      max_attempts: file.retry?.max_attempts ?? 1,
      backoff_s: file.retry?.backoff_s ?? 30,
      on: file.retry?.on ?? ['infra'],
    },
    args_from_job: file.args_from_job ?? false,
    job_env: file.job_env ?? [],
    env_set: file.env_set ?? {},
  }
}

/** Parses a job type file; the first problem is DR101 with its path (e.g. `/classify/0/class`). */
export function parseJobTypeFile(text: string): JobTypeDef {
  return withDefaults(parseYamlFile<JobTypeFile>(text, findJobTypeIssue))
}
