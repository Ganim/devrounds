// Every hash route, declared once: its pattern, its title, its place in the nav and, for a detail route, the list it
// opens beside (P5 design §3 call 7). `:name` takes the rest of the path. Hash routes stay because fastify-static
// serves `/` with no SPA fallback.

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

/** Rail section on a wide screen; the rail draws a divider between groups. */
export type NavGroup = 'plan' | 'operate'
/** On a phone, `bar` entries sit in the bottom bar and `more` entries in its "More" sheet (cx-env `TOOL_SCREENS`). */
export type PhonePlacement = 'bar' | 'more'

type RouteSpec = {
  pattern: string
  title: string
  /** A detail route renders its `master` list in the main column and itself in the aside (a bottom sheet on a phone). */
  master?: RouteName
  nav?: { label: string; group: NavGroup; phone: PhonePlacement }
}

// Order is the nav order. The selected run lives in the path (#/runs/<id>) and the list filters in the query, so a
// detail beside a filtered list is one link (§3 call 7).
export const ROUTES: Record<RouteName, RouteSpec> = {
  roadmap: { pattern: '/', title: 'Roadmap', nav: { label: 'Roadmap', group: 'plan', phone: 'bar' } },
  phase: { pattern: '/phase/:key', title: 'Phase', master: 'roadmap' },
  balance: { pattern: '/balance', title: 'Balance', nav: { label: 'Balance', group: 'plan', phone: 'more' } },
  history: { pattern: '/history', title: 'History', nav: { label: 'History', group: 'plan', phone: 'more' } },
  conventions: {
    pattern: '/conventions',
    title: 'Conventions',
    nav: { label: 'Conventions', group: 'plan', phone: 'more' },
  },
  machines: { pattern: '/machines', title: 'Machines', nav: { label: 'Machines', group: 'operate', phone: 'bar' } },
  queues: { pattern: '/queues', title: 'Queues', nav: { label: 'Queues', group: 'operate', phone: 'more' } },
  jobs: { pattern: '/jobs', title: 'Jobs', nav: { label: 'Jobs', group: 'operate', phone: 'bar' } },
  runs: { pattern: '/runs', title: 'Runs', nav: { label: 'Runs', group: 'operate', phone: 'bar' } },
  run: { pattern: '/runs/:id', title: 'Run', master: 'runs' },
}

// Paths that older links still use (feature pages link #/run/<id> until P5-T12 ports them): same route, other path.
const ALIASES: [pattern: string, name: RouteName][] = [['/run/:id', 'run']]

export type NavEntry = { name: RouteName; href: string; label: string; group: NavGroup; phone: PhonePlacement }

export const NAV: NavEntry[] = (Object.entries(ROUTES) as [RouteName, RouteSpec][]).flatMap(([name, spec]) =>
  spec.nav ? [{ name, href: spec.pattern, ...spec.nav }] : [],
)

// `name` null: no route matches, or a hand-typed param is not valid percent-encoding (#/phase/%); the app shows the
// roadmap with no nav entry active instead of throwing.
export type Route = { name: RouteName | null; params: Record<string, string>; query: URLSearchParams }

const TABLE: [pattern: string, name: RouteName][] = [
  ...(Object.entries(ROUTES) as [RouteName, RouteSpec][]).map(([name, spec]): [string, RouteName] => [
    spec.pattern,
    name,
  ]),
  ...ALIASES,
]

/** The route of a location hash (`#/runs?state=failed`): the query part carries list filters. */
export function matchRoute(hash: string): Route {
  const [path, search = ''] = (hash.replace(/^#/, '') || '/').split('?', 2)
  const query = new URLSearchParams(search)
  for (const [pattern, name] of TABLE) {
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

/** The nav entry a route lights up: its own, or its master's for a detail route. */
export function navOf(name: RouteName | null): RouteName | null {
  if (name === null) return null
  const master = ROUTES[name].master
  return ROUTES[name].nav ? name : (master ?? null)
}

/** The hash of a route with its params and query filled in (`hrefOf('run', {id}, q)` = `#/runs/<id>?<q>`). */
export function hrefOf(name: RouteName, params: Record<string, string> = {}, query?: URLSearchParams): string {
  const path = ROUTES[name].pattern.replace(/:(\w+)/g, (_, param: string) => encodeURIComponent(params[param] ?? ''))
  return `#${path}${query && query.size > 0 ? `?${query}` : ''}`
}
