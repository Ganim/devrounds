import { type Static, Type } from '@sinclair/typebox'
import type { Issue } from '../../yaml-file.ts'
import type { ProviderManifest } from '../manifest.ts'

// The agent-runtime engine (P4 design §2.C): a job type with an `agent` block runs a headless agent session as one
// process. The engine owns the job type block, the prompt template, the session id, results, usage, budgets and the
// failure classes; a provider only turns a launch into argv and env, and its output lines into AgentEvents. Nothing
// here names a runtime: a second one is a second provider.

export const AGENT_RUNTIME_ENGINE = 'agent-runtime'
export const AGENT_RUNTIME_CONTRACT = 1

const Label = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' })
// A rendered prompt travels in the command line, which Windows caps at 32767 characters with everything else.
export const PROMPT_MAX = 16384

/** The job type file's `agent` block. */
export const AgentSchema = Type.Object(
  {
    // A registered agent-runtime provider (engines/registry.ts).
    runtime: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
    // {{job.args.N}} and {{input.<key>}} are the only placeholders (engine.ts renderPrompt).
    prompt: Type.String({ minLength: 1, maxLength: PROMPT_MAX }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    // Checked by the provider: each runtime has its own set.
    permission_mode: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    // The per-run cap the runtime enforces; a budget's usd_per_run lowers it (budgets.ts).
    max_budget_usd: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100000 })),
    system_prompt_append: Type.Optional(Type.String({ minLength: 1, maxLength: PROMPT_MAX })),
    result: Type.Object(
      {
        // reported: the agent calls `devrounds run result`; text: the runtime's final answer; json: that answer as
        // JSON, with `schema` handed to the runtime when it can enforce one.
        kind: Type.Union([Type.Literal('reported'), Type.Literal('text'), Type.Literal('json')]),
        schema: Type.Optional(Type.Object({}, { additionalProperties: true })),
        // Labels a reported result ends the run finished with; any other label fails it, `park` ones as parked.
        done: Type.Optional(Type.Array(Label, { maxItems: 20, uniqueItems: true })),
        park: Type.Optional(Type.Array(Label, { maxItems: 20, uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
    // A retry of a run that left a session resumes it, at most `max` times per job (0: never).
    resume: Type.Optional(
      Type.Object({ max: Type.Integer({ minimum: 0, maximum: 5 }) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)

export type AgentFile = Static<typeof AgentSchema>

/** A job's `input`: the values a prompt reads as {{input.<key>}}. */
export const JobInput = Type.Record(
  Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_-]{0,63}$' }),
  Type.String({ maxLength: PROMPT_MAX }),
  { maxProperties: 50, additionalProperties: false },
)

/** The `agent` block with its defaults, as stored in job_types.agent. */
export type AgentDef = Omit<AgentFile, 'resume' | 'result'> & {
  result: { kind: 'reported' | 'text' | 'json'; schema?: Record<string, unknown>; done: string[]; park: string[] }
  resume: { max: number }
}

export const DEFAULT_RESUME_MAX = 2

/** What a provider gets to build one run's command. */
export type AgentLaunch = {
  prompt: string
  // A fresh session gets this id; a resume continues the session with it.
  session: { id: string; resume: boolean }
  model?: string
  permissionMode?: string
  maxBudgetUsd?: number
  systemPromptAppend?: string
  resultSchema?: Record<string, unknown>
}

/** Arguments after the job type's own command args, and values the run gets over the job type's env_set. */
export type AgentCommand = { args: string[]; env: Record<string, string> }

export type Tokens = { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number }

/**
 * What a provider reads from one output line. Never a tool's input or output, never message text: an event says that
 * something happened, which tool, how it went and what it cost. `call` and `message` are the runtime's opaque ids,
 * used only to pair a tool result with its call and to count a message's usage once.
 */
export type AgentEvent =
  | { kind: 'message'; role: 'assistant' | 'user' | 'system'; chars: number }
  | { kind: 'tool_call'; call: string; name: string }
  | { kind: 'tool_result'; call: string; status: 'ok' | 'error' }
  | { kind: 'permission_request'; tool: string; decision: 'denied' | 'asked' }
  | ({ kind: 'usage'; message: string | null } & Tokens)
  | {
      kind: 'result'
      // limit: the runtime stopped at its own budget or turn limit.
      outcome: 'success' | 'error' | 'limit'
      sessionId: string | null
      costUsd: number | null
      usage: Tokens | null
      // The final answer, for result kinds text and json; cut by the engine.
      text: string | null
      // A runtime that enforced the json schema itself hands the value here.
      structured: unknown
    }

export interface AgentRuntimeProvider {
  manifest: ProviderManifest
  // The program a job type without its own `command` runs.
  program: string
  // What only the runtime knows is wrong with a job type's agent block (a permission mode it lacks), at `/agent/...`.
  checkAgent(agent: AgentDef): Issue | null
  command(launch: AgentLaunch): AgentCommand
  // Every event one output line holds, in order; a line that is not the runtime's (a stray print) holds none.
  parseLine(text: string): AgentEvent[]
}
