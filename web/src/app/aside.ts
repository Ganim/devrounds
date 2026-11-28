import { getDevicePref, setDevicePref } from '../data/prefs.ts'

// The aside's width is the reader's choice, kept per device (P5 design §3 call 9; cx-env `asideWidth`) as the
// `asideWidth` device pref.
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
  const saved = getDevicePref('asideWidth')
  return saved >= ASIDE_MIN ? saved : ASIDE_DEFAULT
}

/** Saves the dragged width, or forgets it (null) so the aside goes back to the default. */
export const saveAside = (width: number | null): void => setDevicePref('asideWidth', width)
