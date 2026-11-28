import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { IconButton } from '../primitives/IconButton.tsx'
import './ComposerShell.css'

const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/**
 * The message box under a thread: a growing textarea, an attach button, a round send button and a slot above it for
 * suggestions (the slash list). Enter rules follow cx-env: on a keyboard, Enter sends and Shift+Enter breaks the line;
 * on touch, Enter breaks the line and Ctrl/Cmd+Enter sends, because a phone keyboard has no Shift+Enter habit.
 * The caller owns the text (drafts per session live in its state).
 */
export function ComposerShell({
  value,
  onChange,
  onSend,
  onAttach,
  placeholder = 'Message',
  disabled = false,
  suggestions,
  label = 'Message',
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onAttach?: () => void
  placeholder?: string
  disabled?: boolean
  suggestions?: ReactNode
  label?: string
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  // Grow with the text up to the CSS max-height, then scroll. Runs after every render: the height follows the DOM.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  })
  const canSend = !disabled && value.trim() !== ''
  return (
    <div className="dr-composer">
      {suggestions ? <div className="dr-composer__suggestions">{suggestions}</div> : null}
      <div className="dr-composer__row">
        {onAttach ? (
          <IconButton icon="paperclip" label="Attach" variant="ghost" disabled={disabled} onClick={onAttach} />
        ) : null}
        <textarea
          ref={box}
          className="dr-composer__input"
          rows={1}
          aria-label={label}
          placeholder={placeholder}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            const send = coarsePointer() ? event.ctrlKey || event.metaKey : !event.shiftKey
            if (!send) return
            event.preventDefault()
            if (canSend) onSend()
          }}
        />
        <IconButton icon="arrow-up" label="Send" variant="primary" disabled={!canSend} onClick={onSend} />
      </div>
    </div>
  )
}
