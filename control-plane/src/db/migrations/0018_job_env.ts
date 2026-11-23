import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Values a run gets beyond the job type's command (job-types/file.ts): `args_from_job` lets a job append arguments,
// `job_env` names the variables a job may set, `env_set` holds the job type's own values; the job keeps its `args`
// and `env`. Values are stored here and sent in the Offer, so they are names and flags, never secrets: a secret stays
// in the machine's environment behind `env_allow`.
const STATEMENTS = [
  'alter table job_types add column args_from_job boolean not null default false',
  `alter table job_types add column job_env text[] not null default '{}'`,
  `alter table job_types add column env_set jsonb not null default '{}'`,
  `alter table jobs add column args jsonb not null default '[]'`,
  `alter table jobs add column env jsonb not null default '{}'`,
]

export const jobEnv: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of STATEMENTS) await sql.raw(statement).execute(db)
  },
}
