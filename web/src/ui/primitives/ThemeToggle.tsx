import { IconButton } from './IconButton.tsx'

type Theme = 'dark' | 'light'

/** The button that flips dark and light; shows the theme it switches to. The app owns where the choice is saved. */
export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (next: Theme) => void }) {
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <IconButton
      icon={next === 'light' ? 'sun' : 'moon'}
      label={`Switch to ${next} theme`}
      variant="ghost"
      onClick={() => onChange(next)}
    />
  )
}
