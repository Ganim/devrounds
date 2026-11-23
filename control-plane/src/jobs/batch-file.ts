import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { EnvValues, JobArgs } from '../job-types/file.ts'
import { type Issue, parseYamlFile } from '../yaml-file.ts'

// A batch file, e.g. `devrounds batch submit batch.yaml`, and the JSON body of `POST /batches`. A job runs once every
// job it depends_on (by ref, inside the batch) finished. Without `machine` any machine may run it; without `queue` it
// goes to the project's `default` queue. `args` and `env` need a job type that allows them (args_from_job, job_env).
// `cache_key` is the caller's key of the job's inputs: a recent finished run with the same key answers for it (cache.ts).
const Key = Type.String({ minLength: 1, maxLength: 200 })

export const BatchJob = Type.Object(
  {
    ref: Key,
    job_type: Key,
    cwd: Type.String({ minLength: 1, maxLength: 1000 }),
    machine: Type.Optional(Key),
    queue: Type.Optional(Key),
    task: Type.Optional(Key),
    depends_on: Type.Optional(Type.Array(Key, { maxItems: 200 })),
    args: Type.Optional(JobArgs),
    env: Type.Optional(EnvValues),
    cache_key: Type.Optional(Key),
  },
  { additionalProperties: false },
)

export const BatchInput = Type.Object(
  { jobs: Type.Array(BatchJob, { minItems: 1, maxItems: 200 }) },
  { additionalProperties: false },
)

export type BatchInput = Static<typeof BatchInput>

export function findBatchIssue(value: unknown): Issue | null {
  const first = Value.Errors(BatchInput, value).First()
  return first ? { path: first.path || '/', reason: first.message } : null
}

/** Parses a batch file; the first problem is DR101 with its path (e.g. `/jobs/0/job_type`). */
export function parseBatchFile(text: string): BatchInput {
  return parseYamlFile<BatchInput>(text, findBatchIssue)
}
