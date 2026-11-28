// The aside's width is the reader's choice, kept per device (P5 design §3 call 9; cx-env `asideWidth`). Stored here
// until P5-T08's data/prefs.ts owns device prefs; the key stays the same when it moves.
export const ASIDE_KEY = 'devrounds.aside'
export const ASIDE_DEFAULT = 420
const ASIDE_MIN = 320
const ASIDE_MAX = 720
// The main column keeps at least this much, so a wide aside never squeezes the list to nothing.
const MAIN_MIN = 480

/** `width` held to 320-720 px and to what leaves the main column (and the rail) room in a `viewport`-wide window. */
export function clampAside(width: number, viewport: number): number {
  return Math.round(Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, viewport - MAIN_MIN, width)))
}

export function savedAside(): number {
  const saved = Number(localStorage.getItem(ASIDE_KEY))
  return Number.isFinite(saved) && saved >= ASIDE_MIN ? saved : ASIDE_DEFAULT
}
