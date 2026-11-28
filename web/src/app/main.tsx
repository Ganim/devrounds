import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PlanView } from '../data/contract.ts'
import { getSession, type Remote, signOut, usePlan } from '../data/resources.ts'
import { BalancePage } from '../features/balance/BalancePage.tsx'
import { ConventionsPage } from '../features/conventions/ConventionsPage.tsx'
import { HistoryPage } from '../features/history/HistoryPage.tsx'
import { JobsPage } from '../features/jobs/JobsPage.tsx'
import { MachinesPage } from '../features/machines/MachinesPage.tsx'
import { PhasePage } from '../features/planning/PhasePage.tsx'
import { RoadmapPage } from '../features/planning/RoadmapPage.tsx'
import { QueuesPage } from '../features/queues/QueuesPage.tsx'
import { RunPage } from '../features/runs/RunPage.tsx'
import { RunsPage } from '../features/runs/RunsPage.tsx'
import { Login } from './Login.tsx'
import { matchRoute, type Route, type RouteName } from './routes.ts'
import { Shell } from './Shell.tsx'
import { publishViewport } from './viewport.ts'
import '../ui/style.css'

const useHash = (): string => {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const onChange = () => setHash(location.hash)
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

const PAGES: Record<RouteName, (route: Route, plan: Remote<PlanView>) => ReactNode> = {
  roadmap: (_, plan) => <RoadmapPage plan={plan} />,
  phase: ({ params }, plan) => <PhasePage phaseKey={params.key} plan={plan} />,
  balance: () => <BalancePage />,
  history: () => <HistoryPage />,
  conventions: () => <ConventionsPage />,
  machines: () => <MachinesPage />,
  queues: () => <QueuesPage />,
  jobs: () => <JobsPage />,
  runs: ({ query }) => <RunsPage filters={query} />,
  run: ({ params }) => <RunPage runId={params.id} />,
}

function App({ onSignedOut }: { onSignedOut: () => void }) {
  const route = matchRoute(useHash())
  const plan = usePlan()
  // An expired or removed session goes back to the sign-in form instead of showing a dead page.
  useEffect(() => {
    if (plan.error?.code === 'DR401') onSignedOut()
  }, [plan.error, onSignedOut])

  const totals = (plan.data?.phases ?? []).reduce(
    (sum, p) => ({ done: sum.done + p.progress.done, total: sum.total + p.progress.total - p.progress.cancelled }),
    { done: 0, total: 0 },
  )
  return (
    <Shell
      route={route}
      render={(shown) => PAGES[shown.name ?? 'roadmap'](shown, plan)}
      project={plan.data?.project.name ?? 'DevRounds'}
      summary={plan.data ? `${totals.done}/${totals.total} tasks done in ${plan.data.phases.length} phases` : ''}
      onSignOut={() => signOut().finally(onSignedOut)}
    />
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
publishViewport()

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
