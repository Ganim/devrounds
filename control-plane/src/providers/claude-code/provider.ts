import {
  AGENT_RUNTIME_CONTRACT,
  AGENT_RUNTIME_ENGINE,
  type AgentCommand,
  type AgentDef,
  type AgentEvent,
  type AgentLaunch,
  type AgentRuntimeProvider,
  type Tokens,
} from '../../engines/agent-runtime/contract.ts'
import type { Issue } from '../../yaml-file.ts'

// Claude Code headless (`claude -p`) as an agent runtime: the flags of cx-env's launcher (P4 design §1.1), output as
// stream-json, one JSON object per line. MCP config and the hub token are P4-T02's: it adds `--mcp-config` and
// `--strict-mcp-config` here once runs have a hub.

const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan']

function command(launch: AgentLaunch): AgentCommand {
  const args = ['-p', launch.prompt, '--output-format', 'stream-json', '--verbose']
  args.push(launch.session.resume ? '--resume' : '--session-id', launch.session.id)
  if (launch.model !== undefined) args.push('--model', launch.model)
  if (launch.permissionMode !== undefined) args.push('--permission-mode', launch.permissionMode)
  if (launch.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(launch.maxBudgetUsd))
  if (launch.systemPromptAppend !== undefined) args.push('--append-system-prompt', launch.systemPromptAppend)
  if (launch.resultSchema !== undefined) args.push('--json-schema', JSON.stringify(launch.resultSchema))
  return { args, env: {} }
}

function checkAgent(agent: AgentDef): Issue | null {
  if (agent.permission_mode !== undefined && !PERMISSION_MODES.includes(agent.permission_mode)) {
    return { path: '/agent/permission_mode', reason: `must be one of ${PERMISSION_MODES.join(', ')}` }
  }
  return null
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function tokens(usage: unknown): Tokens | null {
  if (!isObject(usage)) return null
  return {
    tokensIn: Math.trunc(count(usage.input_tokens)),
    tokensOut: Math.trunc(count(usage.output_tokens)),
    cacheRead: Math.trunc(count(usage.cache_read_input_tokens)),
    cacheWrite: Math.trunc(count(usage.cache_creation_input_tokens)),
  }
}

function blocks(message: Json): Json[] {
  return Array.isArray(message.content) ? message.content.filter(isObject) : []
}

const chars = (content: Json[]) =>
  content.reduce((sum, block) => sum + (block.type === 'text' ? (text(block.text)?.length ?? 0) : 0), 0)

function assistant(message: Json): AgentEvent[] {
  const content = blocks(message)
  const events: AgentEvent[] = []
  if (content.some((block) => block.type === 'text')) {
    events.push({ kind: 'message', role: 'assistant', chars: chars(content) })
  }
  for (const block of content) {
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      events.push({ kind: 'tool_call', call: block.id, name: block.name })
    }
  }
  const usage = tokens(message.usage)
  if (usage) events.push({ kind: 'usage', message: text(message.id), ...usage })
  return events
}

function user(message: Json): AgentEvent[] {
  const content = blocks(message)
  const events: AgentEvent[] = []
  if (typeof message.content === 'string') events.push({ kind: 'message', role: 'user', chars: message.content.length })
  else if (content.some((block) => block.type === 'text')) {
    events.push({ kind: 'message', role: 'user', chars: chars(content) })
  }
  for (const block of content) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      events.push({ kind: 'tool_result', call: block.tool_use_id, status: block.is_error === true ? 'error' : 'ok' })
    }
  }
  return events
}

function result(line: Json): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const denial of Array.isArray(line.permission_denials) ? line.permission_denials.filter(isObject) : []) {
    if (typeof denial.tool_name === 'string') {
      events.push({ kind: 'permission_request', tool: denial.tool_name, decision: 'denied' })
    }
  }
  const subtype = text(line.subtype) ?? ''
  // error_max_turns and error_max_budget_usd: the runtime's own limits.
  const outcome = subtype.startsWith('error_max')
    ? 'limit'
    : subtype === 'success' && line.is_error !== true
      ? 'success'
      : 'error'
  const cost = line.total_cost_usd
  events.push({
    kind: 'result',
    outcome,
    sessionId: text(line.session_id),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    usage: tokens(line.usage),
    text: text(line.result),
    structured: line.structured_output ?? null,
  })
  return events
}

function parseLine(line: string): AgentEvent[] {
  if (!line.startsWith('{')) return []
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObject(value)) return []
  switch (value.type) {
    case 'assistant':
      return isObject(value.message) ? assistant(value.message) : []
    case 'user':
      return isObject(value.message) ? user(value.message) : []
    case 'result':
      return result(value)
    default:
      return []
  }
}

export const claudeCode: AgentRuntimeProvider = {
  manifest: {
    id: 'claude-code',
    engine: AGENT_RUNTIME_ENGINE,
    version: '1.0.0',
    contract: AGENT_RUNTIME_CONTRACT,
    capabilities: ['resume', 'json-schema', 'max-budget'],
    secrets: [],
    tools: [],
  },
  program: 'claude',
  checkAgent,
  command,
  parseLine,
}
