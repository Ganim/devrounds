import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react'
import { cx } from '../cx.ts'
import './Input.css'

/** A text input; `invalid` draws the danger border and sets aria-invalid. React 19 passes `ref` as a prop. */
export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cx('dr-input', className)} />
}

/** A multi-line input; `mono` for commands and code. */
export function Textarea({
  className,
  invalid,
  mono,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; mono?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx('dr-input', 'dr-textarea', mono && 'dr-input--mono', className)}
    />
  )
}

/**
 * A label above one control, with a hint or an error under it. `children` receives the id and the described-by id to
 * put on the control, so the label and the message are wired for screen readers.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode
}) {
  const id = useId()
  const messageId = `${id}-message`
  const message = error || hint
  return (
    <div className="dr-field">
      <label className="dr-field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy: message ? messageId : undefined })}
      {message ? (
        <div id={messageId} className={cx('dr-field__message', error && 'is-error')}>
          {message}
        </div>
      ) : null}
    </div>
  )
}
