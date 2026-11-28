import { useEffect, useSyncExternalStore } from 'react'
import { useDevicePref } from '../data/prefs.ts'

export type Theme = 'dark' | 'light'

const LIGHT_QUERY = '(prefers-color-scheme: light)'

const subscribeOs = (listener: () => void) => {
  const query = matchMedia(LIGHT_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/**
 * The theme on screen: the device pref, or the OS preference when none is saved (null). Keeps `data-theme` on <html>
 * in step after the boot script in data/prefs.ts set it, including when another tab or the OS changes it.
 */
export function useTheme(): Theme {
  const choice = useDevicePref('theme')
  const osLight = useSyncExternalStore(subscribeOs, () => matchMedia(LIGHT_QUERY).matches)
  const theme = choice ?? (osLight ? 'light' : 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  return theme
}
