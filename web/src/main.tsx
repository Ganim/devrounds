import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getSession, type PlanView, signOut, useRemote } from './api.ts'
import { BalancePage } from './BalancePage.tsx'
import { HistoryPage } from './HistoryPage.tsx'
import { Login } from './Login.tsx'
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

function App({ onSignedOut }: { onSignedOut: () => void }) {
  const route = useHash()
  const plan = useRemote<PlanView>('/plan')
  // An expired or removed session goes back to the sign-in form instead of showing a dead page.
  useEffect(() => {
    if (plan.error?.code === 'DR401') onSignedOut()
  }, [plan.error, onSignedOut])

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
          <button type="button" className="link" onClick={() => signOut().finally(onSignedOut)}>
            sign out
          </button>
        </span>
      </header>
      <main>{page}</main>
    </>
  )
}

function Root() {
  // null until get-session answers, so a signed-in browser never flashes the form.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  useEffect(() => {
    getSession().then(
      (session) => setSignedIn(session !== null),
      () => setSignedIn(false),
    )
  }, [])
  const onSignedOut = useCallback(() => setSignedIn(false), [])
  if (signedIn === null) return <p className="muted">Loading...</p>
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />
  return <App onSignedOut={onSignedOut} />
}

// The P0 view kept a pasted API token here; session login replaced it, so no browser keeps one around.
localStorage.removeItem('devrounds.token')

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
