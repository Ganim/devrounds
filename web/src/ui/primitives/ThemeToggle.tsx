import { useState } from 'react'
import { currentTheme, setTheme } from '../theme.ts'
import { IconButton } from './IconButton.tsx'

/** The header button that flips dark and light; shows the theme it switches to. */
export function ThemeToggle() {
  const [theme, setShown] = useState(currentTheme)
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <IconButton
      icon={next === 'light' ? 'sun' : 'moon'}
      label={`Switch to ${next} theme`}
      variant="ghost"
      onClick={() => {
        setTheme(next)
        setShown(next)
      }}
    />
  )
}
