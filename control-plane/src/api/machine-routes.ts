import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.ts'
import type { Sessions } from '../executor/gateway.ts'
import { createPairingCode, MACHINE_NAME } from '../machines/pairing.ts'
import { closeRevoked, listMachines, revokeMachine } from '../machines/service.ts'
import { runEvents } from '../runs/dispatch.ts'
import { mutateIdempotent } from './idempotency.ts'
import { authenticateMembers, memberCtx } from './members.ts'

const Name = Type.String({ pattern: MACHINE_NAME })
const Headers = Type.Object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) })

// Member routes for the tenant's machines. Creating codes and revoking are for human members (DR453).
export const machineRoutes: FastifyPluginAsyncTypebox<{ db: Kysely<Database>; sessions: Sessions }> = async (
  app,
  { db, sessions },
) => {
  authenticateMembers(app, db)

  app.get('/', async (request) => {
    const machines = await listMachines(memberCtx(db, request))
    return machines.map((machine) => ({ ...machine, connected: sessions.get(machine.id) !== undefined }))
  })

  // Exempt from Idempotency-Key: a stored replay would keep the code's plaintext for 24 h, and codes are stored only
  // as SHA-256. A retry mints a new code.
  app.post(
    '/pairing-codes',
    { schema: { body: Type.Object({ name: Name }, { additionalProperties: false }) } },
    async (request) => {
      const { code, expiresAt } = await createPairingCode(memberCtx(db, request), request.body.name)
      return { code, expiresAt, machineName: request.body.name }
    },
  )

  app.post(
    '/:name/revoke',
    { schema: { headers: Headers, params: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }) } },
    async (request, reply) => {
      let revoked: { machineId: string; failedRuns: string[] } | undefined
      const sent = await mutateIdempotent(db, request, reply, async (ctx) => {
        const { name, machineId, failedRuns } = await revokeMachine(ctx, request.params.name)
        revoked = { machineId, failedRuns }
        return { name }
      })
      // mutateIdempotent has committed by now; a replayed key revokes nothing and closes nothing.
      if (revoked) {
        closeRevoked(sessions, revoked.machineId)
        for (const run of revoked.failedRuns) runEvents.emit('changed', run)
      }
      return sent
    },
  )
}
