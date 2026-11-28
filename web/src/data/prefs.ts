import { useSyncExternalStore } from 'react'

// Device prefs (P5 design §3 call 8): what stays in this browser's localStorage, such as the selected project, theme
// and aside width. Member prefs, which follow the member across devices, are `useMemberPref` in resources.ts. This
// file imports nothing from data/, so http.ts can read the project from it without an import cycle.

type DevicePrefs = {
  project: string
  // null follows prefers-color-scheme.
  theme: 'dark' | 'light' | null
  asideWidth: number
}

type Spec<T> = { storageKey: string; fallback: T; parse: (raw: string) => T | undefined }

// The storage keys are read outside React too: the theme is applied by an inline script before first paint (design §3
// call 10), so `devrounds.theme` is renamed only together with that script.
const DEVICE: { [K in keyof DevicePrefs]: Spec<DevicePrefs[K]> } = {
  project: { storageKey: 'devrounds.project', fallback: 'devrounds', parse: (raw) => raw.trim() || undefined },
  theme: {
    storageKey: 'devrounds.theme',
    fallback: null,
    parse: (raw) => (raw === 'dark' || raw === 'light' ? raw : undefined),
  },
  asideWidth: {
    // The key P5-T09's shell already wrote, so a saved width survives the move here.
    storageKey: 'devrounds.aside',
    fallback: 420,
    parse: (raw) => {
      const width = Number(raw)
      return Number.isFinite(width) && width > 0 ? width : undefined
    },
  },
}

const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
// Another tab changed a pref: this tab's components re-read it.
// Optional call: node tests import modules that import this file, and node has no window.
globalThis.addEventListener?.('storage', notify)

export function getDevicePref<K extends keyof DevicePrefs>(name: K): DevicePrefs[K] {
  const { storageKey, fallback, parse } = DEVICE[name]
  const raw = localStorage.getItem(storageKey)
  return (raw === null ? undefined : parse(raw)) ?? fallback
}

/** Stores `value` (null removes the key, back to the fallback) and re-renders every component reading it. */
export function setDevicePref<K extends keyof DevicePrefs>(name: K, value: DevicePrefs[K] | null): void {
  const { storageKey } = DEVICE[name]
  if (value === null) localStorage.removeItem(storageKey)
  else localStorage.setItem(storageKey, String(value))
  notify()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useDevicePref = <K extends keyof DevicePrefs>(name: K): DevicePrefs[K] =>
  useSyncExternalStore(subscribe, () => getDevicePref(name))

export const getProject = (): string => getDevicePref('project')
export const setProject = (key: string): void => setDevicePref('project', key.trim() || 'devrounds')
