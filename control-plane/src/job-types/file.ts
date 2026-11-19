import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { FailureClass } from '../db/schema.ts'
import { FAILURE_CLASSES, RULE_CLASSES } from '../runs/classify.ts'
import { type Issue, parseYamlFile } from '../yaml-file.ts'

// A job type file, e.g. `devrounds jobtype set check.yaml`. Omitted fields take the defaults of the job_types columns.
const Key = Type.String({ minLength: 1, maxLength: 200 })
const OneOf = <T extends string[]>(...words: [...T]) => Type.Union(words.map((word) => Type.Literal(word)))

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
}

// Schema first, then what a schema cannot say: a rule needs a condition (or it would swallow every failure), a
// pattern must compile, and cancelled (a person stopped the run) is never retried.
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
  const on = (value as JobTypeFile).retry?.on ?? []
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
  }
}

/** Parses a job type file; the first problem is DR101 with its path (e.g. `/classify/0/class`). */
export function parseJobTypeFile(text: string): JobTypeDef {
  return withDefaults(parseYamlFile<JobTypeFile>(text, findJobTypeIssue))
}
