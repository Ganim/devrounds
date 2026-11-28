import './Toggle.css'

/** An on/off switch (cx-env `.sw`). With `label` the text sits on its left and clicking it toggles too. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="dr-toggle">
      <span className="dr-toggle__label">{label}</span>
      <button
        type="button"
        role="switch"
        className="dr-toggle__switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </label>
  )
}
