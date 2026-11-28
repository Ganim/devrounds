import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { fail } from '../errors/error.ts'

// What every provider declares about itself (P4 design §2.B 14), checked when the registry loads (registry.ts) so a
// provider with a bad manifest never serves a run. Engines read it; they never look at a provider's code to learn
// what it needs. `tools` and `secrets` are filled by the providers that have them (the hub, P4-T02; the vault,
// P4-T01); an agent runtime has neither today.
const Id = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' })
const Risk = Type.Union([Type.Literal('read'), Type.Literal('write-internal'), Type.Literal('publish-external')])

export const ProviderManifest = Type.Object(
  {
    id: Id,
    engine: Id,
    version: Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' }),
    // The engine contract version the provider implements; the engine refuses another.
    contract: Type.Integer({ minimum: 1 }),
    capabilities: Type.Array(Id, { uniqueItems: true }),
    // Names of vault secrets the provider needs, and the variable each reaches a run as, if any.
    secrets: Type.Array(
      Type.Object(
        { name: Id, as: Type.Optional(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,199}$' })) },
        { additionalProperties: false },
      ),
    ),
    tools: Type.Array(
      Type.Object(
        { name: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }), risk: Risk },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export type ProviderManifest = Static<typeof ProviderManifest>

/** The manifest, or DR501 naming the provider and the first problem: a broken manifest is this build's fault. */
export function checkManifest(manifest: unknown, engine: string, contract: number): ProviderManifest {
  const first = Value.Errors(ProviderManifest, manifest).First()
  const id = (manifest as { id?: unknown } | null)?.id
  if (first) fail('DR501', { reason: `provider ${String(id)} manifest at ${first.path || '/'}: ${first.message}` })
  const checked = manifest as ProviderManifest
  if (checked.engine !== engine) {
    fail('DR501', { reason: `provider ${checked.id} is for engine ${checked.engine}, registered under ${engine}` })
  }
  if (checked.contract !== contract) {
    fail('DR501', {
      reason: `provider ${checked.id} implements contract ${checked.contract}; ${engine} is ${contract}`,
    })
  }
  return checked
}
