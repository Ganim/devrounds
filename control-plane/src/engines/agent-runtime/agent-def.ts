import type { Issue } from '../../yaml-file.ts'
import { agentRuntimeIds, findAgentRuntime } from '../registry.ts'
import { type AgentDef, type AgentFile, DEFAULT_RESUME_MAX } from './contract.ts'
import { badPlaceholder } from './prompt.ts'

/** The job type file's `agent` block with its defaults, as job_types.agent stores it. */
export function agentWithDefaults(file: AgentFile): AgentDef {
  return {
    ...file,
    result: {
      kind: file.result.kind,
      ...(file.result.schema === undefined ? {} : { schema: file.result.schema }),
      done: file.result.done ?? [],
      park: file.result.park ?? [],
    },
    resume: { max: file.resume?.max ?? DEFAULT_RESUME_MAX },
  }
}

/** What the schema cannot say about an `agent` block (it already passed the schema), or null. */
export function findAgentIssue(file: AgentFile): Issue | null {
  const provider = findAgentRuntime(file.runtime)
  if (!provider)
    return {
      path: '/agent/runtime',
      reason: `no agent runtime ${file.runtime}; known: ${agentRuntimeIds().join(', ')}`,
    }
  for (const field of ['prompt', 'system_prompt_append'] as const) {
    const bad = file[field] === undefined ? null : badPlaceholder(file[field])
    if (bad) return { path: `/agent/${field}`, reason: `${bad} is not {{job.args.N}} or {{input.<key>}}` }
  }
  const { kind, done, park, schema } = file.result
  if (kind === 'reported' && (done ?? []).length === 0) {
    return { path: '/agent/result/done', reason: 'a reported result needs the labels that end the run finished' }
  }
  if (kind !== 'reported' && ((done ?? []).length > 0 || (park ?? []).length > 0)) {
    return { path: '/agent/result', reason: 'done and park are labels of a reported result' }
  }
  if (kind !== 'json' && schema !== undefined)
    return { path: '/agent/result/schema', reason: 'only a json result has a schema' }
  const both = (done ?? []).find((label) => (park ?? []).includes(label))
  if (both !== undefined) return { path: '/agent/result/park', reason: `${both} is also a done label` }
  return provider.checkAgent(agentWithDefaults(file))
}
