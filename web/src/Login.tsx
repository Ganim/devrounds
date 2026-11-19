import { useState } from 'react'
import { type ApiError, getProject, setProject, signIn } from './api.ts'
import { ErrorBox } from './ui.tsx'

// Email and password from `devrounds-admin login create`. Better Auth sets the session cookie on success.
export function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [project, setKey] = useState(getProject())
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        signIn(email.trim(), password).then(
          () => {
            setProject(project)
            onDone()
          },
          (err: ApiError) => {
            setError(err)
            setBusy(false)
          },
        )
      }}
    >
      <h1>DevRounds</h1>
      <label>
        Email
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        Project key
        <input value={project} onChange={(e) => setKey(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button type="submit" disabled={busy || email.trim() === '' || password === ''}>
        Sign in
      </button>
    </form>
  )
}
