import { createHash, randomBytes } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import type { Database } from '../db/schema.ts'
import { fail } from '../errors/error.ts'
import { type Ctx, run } from '../planning/resolve.ts'

// Crockford-style: no I, L, O or U, so a code read aloud or retyped has no look-alikes. 32 symbols, so one random byte
// masked to 5 bits picks each one without bias.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/
export const CODE_TTL_MS = 10 * 60_000

// 32 random bytes in base64url are always 43 characters.
const MACHINE_TOKEN = /^drm_[A-Za-z0-9_-]{43}$/

// Machine names end up in CLI arguments and URLs; keep them plain.
export const MACHINE_NAME = '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'

const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 10 * 60_000
const LOCK_MS = 10 * 60_000

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

export function requireHuman(ctx: Ctx, action: string): void {
  if (ctx.actor.kind !== 'human') fail('DR453', { action })
}

/**
 * Failed redemptions in this process: 5 within 10 min lock pairing for everyone for 10 min. Redemption happens before
 * any tenant is known, so the lock cannot be per tenant; it bounds guessing at 5 tries per 10 min against codes that
 * live 10 min, out of 32^8 values. In memory on purpose: one control plane process, and a restart that clears it
 * costs an attacker far more time than it saves.
 */
export class PairingLimiter {
  #clock: () => number
  #failures: number[] = []
  #lockedUntil = 0

  constructor(clock: () => number = Date.now) {
    this.#clock = clock
  }

  check(): void {
    const left = this.#lockedUntil - this.#clock()
    if (left > 0) fail('DR451', { minutes: Math.ceil(left / 60_000) })
  }

  failed(): void {
    const now = this.#clock()
    this.#failures = [...this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS), now]
    if (this.#failures.length >= MAX_FAILURES) {
      this.#lockedUntil = now + LOCK_MS
      this.#failures = []
    }
  }
}

/** A single-use code that pairs one machine named `machineName` into the caller's tenant within 10 minutes. */
export async function createPairingCode(ctx: Ctx, machineName: string): Promise<{ code: string; expiresAt: Date }> {
  requireHuman(ctx, 'create a pairing code')
  const code = [...randomBytes(CODE_LENGTH)].map((byte) => CODE_ALPHABET[byte & 31]).join('')
  return run(ctx, async (trx) => {
    // Checked here so the member hears it now; redemption would fail on the unique index much later, at the machine.
    const live = await trx
      .selectFrom('machines')
      .select('id')
      .where('name', '=', machineName)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (live) {
      fail('DR101', { path: '/name', reason: `machine ${machineName} is already paired; revoke it first` })
    }
    const row = await trx
      .insertInto('pairing_codes')
      .values({
        tenant_id: ctx.tenantId,
        code_hash: sha256(code),
        machine_name: machineName,
        created_by: ctx.actor.id,
        expires_at: sql<Date>`now() + ${`${CODE_TTL_MS} milliseconds`}::interval`,
      })
      .returning('expires_at')
      .executeTakeFirstOrThrow()
    return { code, expiresAt: row.expires_at }
  })
}

/**
 * Trades a pairing code for a machine and its token. The token's plaintext is returned once, for the executor to keep;
 * only its SHA-256 is stored. An unknown, expired or used code, and a malformed one, count as a failure (DR450).
 */
export async function redeemPairingCode(
  db: Kysely<Database>,
  limiter: PairingLimiter,
  code: string,
  executor: { os: string; version: string },
): Promise<{ machineId: string; machineName: string; token: string }> {
  limiter.check()
  const normalized = code.trim().toUpperCase()
  const token = `drm_${randomBytes(32).toString('base64url')}`
  let rows: { tenant_id: string; machine_id: string; machine_name: string }[] = []
  if (CODE.test(normalized)) {
    try {
      const result = await sql<{ tenant_id: string; machine_id: string; machine_name: string }>`
        select tenant_id, machine_id, machine_name
        from redeem_pairing_code(${sha256(normalized)}, ${sha256(token)}, ${executor.os}, ${executor.version})`.execute(
        db,
      )
      rows = result.rows
    } catch (err) {
      // The name was paired by another code since this one was made: the code stays unused, and is unusable.
      if ((err as { code?: unknown } | null)?.code !== '23505') throw err
    }
  }
  const row = rows[0]
  if (!row) {
    limiter.failed()
    return fail('DR450')
  }
  return { machineId: row.machine_id, machineName: row.machine_name, token }
}

/** The machine of a live token. Missing, malformed, unknown and revoked tokens all answer DR452. */
export async function resolveMachineToken(
  db: Kysely<Database>,
  token: string | undefined,
): Promise<{ tenantId: string; machineId: string }> {
  if (token === undefined || !MACHINE_TOKEN.test(token)) return fail('DR452')
  const { rows } = await sql<{ tenant_id: string; machine_id: string }>`
    select tenant_id, machine_id from resolve_machine_token(${sha256(token)})`.execute(db)
  const row = rows[0] ?? fail('DR452')
  return { tenantId: row.tenant_id, machineId: row.machine_id }
}
