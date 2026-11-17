// Codes are `DR` + 3 digits by range and never renumbered. Add one only in the task that first emits it.
export const ERROR_CODES = ['DR101', 'DR501'] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

// Exit 4 (control plane unreachable) is not a code: only the CLI produces it, when no response came back.
const EXIT_BY_RANGE: Record<string, number> = { '1': 2, '2': 3, '3': 1, '4': 5, '5': 6 }

export function exitCodeFor(code: string): number {
  return EXIT_BY_RANGE[code[2]]
}
