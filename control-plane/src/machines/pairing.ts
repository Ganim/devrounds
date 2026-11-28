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
// Across all sources: ten sources' worth of lockouts per window. Bounds guessing from many addresses, and with it the
// per-source map (see PairingLimiter).
const GLOBAL_MAX_FAILURES = 50

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

export function requireHuman(ctx: Ctx, action: string): void {
  if (ctx.actor.kind !== 'human') fail('DR453', { action })
}

type SourceState = { failures: number[]; lockedUntil: number; inFlight: number }

/**
 * Failed redemptions in this process, keyed by source address: 5 within 10 min from one source lock pairing for that
 * source for 10 min, so one source's guesses never lock pairing for another. Redemption happens before any tenant is
 * known, so the key cannot be the tenant. A global ceiling of 50 failures per sliding 10 min refuses every source while
 * reached; it bounds guessing from many addresses at 50 tries per 10 min against codes that live 10 min, out of 32^8
 * values. In memory on purpose: one control plane process, and a restart that clears it costs an attacker far more
 * time than it saves.
 *
 * The map holds only sources with a failure in the window, a lock or an attempt in flight; every reserve evicts the
 * rest. A source enters only by taking a slot under the global ceiling, so at most about 2x GLOBAL_MAX_FAILURES
 * entries live at once (one window of failures plus the locks set in the window before), whatever the number of
 * addresses.
 */
export class PairingLimiter {
  #clock: () => number
  #sources = new Map<string, SourceState>()
  #failures: number[] = []
  #inFlight = 0

  constructor(clock: () => number = Date.now) {
    this.#clock = clock
  }

  /** How many sources the limiter holds state for; tests check the memory bound with it. */
  get trackedSources(): number {
    return this.#sources.size
  }

  /**
   * Takes a slot for `source` before the redemption awaits, so a burst of concurrent guesses cannot all pass before
   * the first failure lands: DR451 while the source is locked, or while its recent failures plus attempts in flight
   * already reach the limit, and the same against the global ceiling. Call the returned function once, with whether
   * the attempt counts as a failure.
   */
  reserve(source: string): (failure: boolean) => void {
    const now = this.#clock()
    this.#evict(now)
    const state = this.#sources.get(source) ?? { failures: [], lockedUntil: 0, inFlight: 0 }
    const left = state.lockedUntil - now
    if (left > 0) fail('DR451', { minutes: Math.ceil(left / 60_000) })
    // Not locked yet, but the attempts in flight would lock it if they fail: answer as the lock would.
    if (state.failures.length + state.inFlight >= MAX_FAILURES) fail('DR451', { minutes: LOCK_MS / 60_000 })
    if (this.#failures.length + this.#inFlight >= GLOBAL_MAX_FAILURES) {
      // Sliding: it opens again as the oldest failure leaves the window.
      const [oldest] = this.#failures
      const reopensIn = oldest === undefined ? FAILURE_WINDOW_MS : oldest + FAILURE_WINDOW_MS - now
      fail('DR451', { minutes: Math.ceil(reopensIn / 60_000) })
    }
    this.#sources.set(source, state)
    state.inFlight++
    this.#inFlight++
    let settled = false
    return (failure) => {
      if (settled) return
      settled = true
      state.inFlight--
      this.#inFlight--
      if (failure) this.#failed(state)
      else if (state.failures.length === 0 && state.lockedUntil === 0 && state.inFlight === 0) {
        this.#sources.delete(source)
      }
    }
  }

  // The entry is still in the map: #evict never drops a source with an attempt in flight.
  #failed(state: SourceState): void {
    const now = this.#clock()
    this.#failures.push(now)
    state.failures = [...state.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now]
    if (state.failures.length >= MAX_FAILURES) {
      state.lockedUntil = now + LOCK_MS
      state.failures = []
    }
  }

  #evict(now: number): void {
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS)
    for (const [source, state] of this.#sources) {
      state.failures = state.failures.filter((at) => now - at < FAILURE_WINDOW_MS)
      if (state.lockedUntil <= now) state.lockedUntil = 0
      if (state.failures.length === 0 && state.lockedUntil === 0 && state.inFlight === 0) this.#sources.delete(source)
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
 * only its SHA-256 is stored. An unknown, expired or used code, and a malformed one, count as a failure (DR450) of
 * `source`, the caller's address.
 */
export async function redeemPairingCode(
  db: Kysely<Database>,
  limiter: PairingLimiter,
  code: string,
  executor: { os: string; version: string },
  source: string,
): Promise<{ machineId: string; machineName: string; token: string }> {
  const settle = limiter.reserve(source)
  let failure = true
  try {
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
        if ((err as { code?: unknown } | null)?.code !== '23505') throw err
        // The name was paired by another code since this one was made. A right code, so not a guess: the code stays
        // unused and works again once that machine is revoked, within its 10 minutes.
        failure = false
        fail('DR101', {
          path: '/code',
          reason: "this code's machine name is already paired; revoke that machine first",
        })
      }
    }
    const row = rows[0] ?? fail('DR450')
    failure = false
    return { machineId: row.machine_id, machineName: row.machine_name, token }
  } finally {
    settle(failure)
  }
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
