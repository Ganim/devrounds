// Every hash route, declared once: its pattern and its place in the nav. `:name` takes the rest of the path.

export type RouteName =
  | 'roadmap'
  | 'phase'
  | 'balance'
  | 'history'
  | 'conventions'
  | 'machines'
  | 'queues'
  | 'jobs'
  | 'runs'
  | 'run'

const PATTERNS: Record<RouteName, string> = {
  roadmap: '/',
  phase: '/phase/:key',
  balance: '/balance',
  history: '/history',
  conventions: '/conventions',
  machines: '/machines',
  queues: '/queues',
  jobs: '/jobs',
  runs: '/runs',
  run: '/run/:id',
}

/** The nav, in order; an entry is active on its own route and on the detail routes listed with it. */
export const NAV: { href: string; label: string; active: RouteName[] }[] = [
  { href: '/', label: 'Roadmap', active: ['roadmap', 'phase'] },
  { href: '/balance', label: 'Balance', active: ['balance'] },
  { href: '/history', label: 'History', active: ['history'] },
  { href: '/conventions', label: 'Conventions', active: ['conventions'] },
  // The operational view, after the planning pages.
  { href: '/machines', label: 'Machines', active: ['machines'] },
  { href: '/queues', label: 'Queues', active: ['queues'] },
  { href: '/jobs', label: 'Jobs', active: ['jobs'] },
  { href: '/runs', label: 'Runs', active: ['runs', 'run'] },
]

// `name` null: no route matches, or a hand-typed param is not valid percent-encoding (#/phase/%); the app shows the
// roadmap with no nav entry active instead of throwing.
export type Route = { name: RouteName | null; params: Record<string, string>; query: URLSearchParams }

/** The route of a location hash (`#/runs?state=failed`): the query part carries list filters. */
export function matchRoute(hash: string): Route {
  const [path, search = ''] = (hash.replace(/^#/, '') || '/').split('?', 2)
  const query = new URLSearchParams(search)
  for (const [name, pattern] of Object.entries(PATTERNS) as [RouteName, string][]) {
    const names: string[] = []
    const source = pattern.replace(/:(\w+)/g, (_, param: string) => {
      names.push(param)
      return '(.+)'
    })
    const found = new RegExp(`^${source}$`).exec(path)
    if (!found) continue
    try {
      const params = Object.fromEntries(names.map((param, i) => [param, decodeURIComponent(found[i + 1])]))
      return { name, params, query }
    } catch {
      break
    }
  }
  return { name: null, params: {}, query }
}
