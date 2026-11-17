import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { clearToken, getProject, getToken, type PlanView, setProject, setToken, useRemote } from './api.ts'
import { BalancePage } from './BalancePage.tsx'
import { HistoryPage } from './HistoryPage.tsx'
import { PhasePage } from './PhasePage.tsx'
import { RoadmapPage } from './Roadmap.tsx'
import './style.css'

const useHash = (): string => {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return hash.replace(/^#/, '') || '/'
}

// A hand-typed hash like #/phase/% is not valid percent-encoding; treat it as the roadmap instead of throwing.
function phaseOf(route: string): string | undefined {
  const raw = /^\/phase\/(.+)$/.exec(route)?.[1]
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setValue] = useState('')
  const [project, setKey] = useState(getProject())
  return (
    <form
      className="login"
      onSubmit={(e) => {
        e.preventDefault()
        setToken(token)
        setProject(project)
        onDone()
      }}
    >
      <h1>DevRounds</h1>
      <label>
        API token
        <input type="password" value={token} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label>
        Project key
        <input value={project} onChange={(e) => setKey(e.target.value)} />
      </label>
      <button type="submit" disabled={token.trim() === ''}>
        Open
      </button>
      <p className="muted">The token stays in the localStorage of this browser.</p>
    </form>
  )
}

function App({ onSignOut }: { onSignOut: () => void }) {
  const route = useHash()
  const plan = useRemote<PlanView>('/plan')
  // A rejected token goes back to the login form instead of showing a dead page.
  useEffect(() => {
    if (plan.error?.code === 'DR401') onSignOut()
  }, [plan.error, onSignOut])

  const phaseKey = phaseOf(route)
  const totals = (plan.data?.phases ?? []).reduce(
    (sum, p) => ({ done: sum.done + p.progress.done, total: sum.total + p.progress.total - p.progress.cancelled }),
    { done: 0, total: 0 },
  )
  const link = (href: string, label: string, active: boolean) => (
    <a href={`#${href}`} className={active ? 'active' : ''}>
      {label}
    </a>
  )
  let page = <RoadmapPage plan={plan} />
  if (phaseKey !== undefined) page = <PhasePage phaseKey={phaseKey} plan={plan} />
  else if (route === '/balance') page = <BalancePage />
  else if (route === '/history') page = <HistoryPage />
  return (
    <>
      <header className="top">
        <h1>{plan.data?.project.name ?? 'DevRounds'}</h1>
        <nav>
          {link('/', 'Roadmap', route === '/' || phaseKey !== undefined)}
          {link('/balance', 'Balance', route === '/balance')}
          {link('/history', 'History', route === '/history')}
        </nav>
        <span className="totals">
          {plan.data ? `${totals.done}/${totals.total} tasks done in ${plan.data.phases.length} phases ` : ''}
          <button type="button" className="link" onClick={onSignOut}>
            sign out
          </button>
        </span>
      </header>
      <main>{page}</main>
    </>
  )
}

function Root() {
  const [signedIn, setSignedIn] = useState(getToken() !== '')
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />
  return (
    <App
      onSignOut={() => {
        clearToken()
        setSignedIn(false)
      }}
    />
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
