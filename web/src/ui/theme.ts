export type Theme = 'dark' | 'light'

/** Device-local, same key cx-env uses, so a browser that picked a theme there keeps it here. */
export const THEME_KEY = 'devrounds.theme'

/**
 * Runs inline in index.html before the first paint (web/build.ts), so a reload never flashes the other theme: the
 * saved choice, else the OS preference, else dark (P5 design §3 call 10).
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}`

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

/** Applies and saves a theme; a browser that refuses storage still switches for this page. */
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Private mode or storage disabled: the choice lasts until reload.
  }
}
