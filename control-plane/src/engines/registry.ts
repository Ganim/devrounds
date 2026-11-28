import { fail } from '../errors/error.ts'
import { claudeCode } from '../providers/claude-code/provider.ts'
import { AGENT_RUNTIME_CONTRACT, AGENT_RUNTIME_ENGINE, type AgentRuntimeProvider } from './agent-runtime/contract.ts'
import { checkManifest } from './manifest.ts'

// Every provider this build ships, registered here and nowhere else (P4 design §2.B 14): an engine asks the registry
// for a provider by id, so the engine's code never imports one. Manifests are checked at load, so a bad one fails the
// start, not a run. Other engines (secrets, the hub's) add their own list here.
const AGENT_RUNTIMES: AgentRuntimeProvider[] = [claudeCode]

const agentRuntimes = new Map<string, AgentRuntimeProvider>()
for (const provider of AGENT_RUNTIMES) {
  const manifest = checkManifest(provider.manifest, AGENT_RUNTIME_ENGINE, AGENT_RUNTIME_CONTRACT)
  if (agentRuntimes.has(manifest.id)) fail('DR501', { reason: `agent runtime ${manifest.id} is registered twice` })
  agentRuntimes.set(manifest.id, provider)
}

/** The agent-runtime provider `id`, or undefined when none is registered. */
export function findAgentRuntime(id: string): AgentRuntimeProvider | undefined {
  return agentRuntimes.get(id)
}

/** Ids of the registered agent runtimes, for a DR101 that lists them. */
export function agentRuntimeIds(): string[] {
  return [...agentRuntimes.keys()].sort()
}
