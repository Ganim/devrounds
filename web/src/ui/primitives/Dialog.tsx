import { type ReactNode, useEffect, useRef } from 'react'
import { cx } from '../cx.ts'
import { IconButton } from './IconButton.tsx'
import './Dialog.css'

/**
 * A modal on the native `<dialog>`: top layer, focus trap and Esc come from the browser, and Esc closes only the
 * topmost one (cx-env: Esc closes the topmost layer). Under 900 px it is a bottom sheet. A click on the backdrop
 * closes it. `actions` sit at the bottom right; `wide` for tables and diffs.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  actions,
  wide = false,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={cx('dr-dialog', wide && 'dr-dialog--wide')}
      aria-label={title}
      onClose={onClose}
      // The browser closes the dialog on Esc; stop the key there so a window-level Esc handler (the shell's detail
      // panel, app/layers.ts) does not close the layer under it too.
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
      }}
      onPointerDown={(event) => {
        // The dialog box itself is only hit outside the inner frame, i.e. on the backdrop.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {open ? (
        <div className="dr-dialog__frame">
          <span className="dr-dialog__handle" aria-hidden="true" />
          <header className="dr-dialog__head">
            <div className="dr-dialog__titles">
              <h2>{title}</h2>
              {subtitle ? <div className="dr-dialog__subtitle">{subtitle}</div> : null}
            </div>
            <IconButton icon="x" label="Close" size="sm" variant="ghost" onClick={onClose} />
          </header>
          <div className="dr-dialog__body">{children}</div>
          {actions ? <footer className="dr-dialog__actions">{actions}</footer> : null}
        </div>
      ) : null}
    </dialog>
  )
}
