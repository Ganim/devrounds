// Codes are `DR` + 3 digits by range and never renumbered. Add one only in the task that first emits it.
export const ERROR_CODES = [
  'DR101',
  'DR103',
  'DR104',
  'DR150',
  'DR151',
  'DR152',
  'DR153',
  'DR201',
  'DR202',
  'DR203',
  'DR301',
  'DR302',
  'DR303',
  'DR304',
  'DR305',
  'DR306',
  'DR307',
  'DR308',
  'DR309',
  'DR310',
  'DR311',
  'DR312',
  'DR313',
  'DR314',
  'DR350',
  'DR351',
  'DR352',
  'DR401',
  'DR402',
  'DR450',
  'DR451',
  'DR452',
  'DR453',
  'DR501',
  'DR502',
  'DR503',
  'DR504',
  'DR550',
  'DR551',
  'DR552',
  'DR553',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

// Unknown ranges fall back to 6 so a malformed code never becomes exit 0.
// Exit 4 (control plane unreachable) is not a code: only the CLI produces it, when no response came back.
const EXIT_BY_RANGE: Record<string, number> = { '1': 2, '2': 3, '3': 1, '4': 5, '5': 6 }

export function exitCodeFor(code: string): number {
  return EXIT_BY_RANGE[code[2]] ?? 6
}
