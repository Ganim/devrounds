// The wire carries counts as u32 and FILETIMEs as decimal u64 (executor/protocol.ts), wider than the int4 and int8
// columns that keep them. A value past the column is stored at its maximum: an event refused by Postgres would be
// retried forever, and no real count or start time gets there.

const INT4_MAX = 2147483647
const INT8_MAX = 9223372036854775807n

/** A u32 count for an int4 column. */
export function int4(value: number): number {
  return Math.min(value, INT4_MAX)
}

/** A decimal u64 for an int8 column, as the decimal string Kysely binds. */
export function int8(decimal: string): string {
  const value = BigInt(decimal)
  return (value > INT8_MAX ? INT8_MAX : value).toString()
}
