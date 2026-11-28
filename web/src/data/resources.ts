import { useEffect, useState } from 'react'
import { type Endpoint, endpoints, type LogPageJson, type SignedIn } from './contract.ts'
import { type ApiError, request, urlOf } from './http.ts'

// Features read the API only through the hooks below, so P5-T08 can move them onto a query cache without touching a
// page.

const POLL_MS = 10_000

export type Remote<T> = { data: T | null; error: ApiError | null }

/**
 * Keyset paging of a list route (api/view-routes.ts): `older` follows the answer's nextCursor, `newer` goes back one
 * page. The cursors belong to `filters`: other filters start over at the newest page, in the same render.
 */
export function usePages(filters: string) {
  const [state, setState] = useState<{ filters: string; stack: string[] }>({ filters, stack: [] })
  const stack = state.filters === filters ? state.stack : []
  return {
    cursor: stack.at(-1),
    page: stack.length + 1,
    older: (next: string) => setState({ filters, stack: [...stack, next] }),
    newer: () => setState({ filters, stack: stack.slice(0, -1) }),
  }
}

// Fetches `url` now and every 10 s (P0 exception; P5 replaces polling with SSE). The previous data stays on screen
// while a refresh is in flight or fails, so a hiccup does not blank the page.
function useRemote<T>(url: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null })
  useEffect(() => {
    let live = true
    const load = () =>
      request<T>(url).then(
        (data) => live && setState({ data, error: null }),
        (error: ApiError) => live && setState((s) => ({ data: s.data, error })),
      )
    setState({ data: null, error: null })
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [url])
  return state
}

const useEndpoint = <T>(endpoint: Endpoint<T>, params?: Record<string, string | number>, query?: URLSearchParams) =>
  useRemote<T>(urlOf(endpoint, params, query))

export const usePlan = () => useEndpoint(endpoints.plan)
export const useBalance = (period: string) => useEndpoint(endpoints.balance, {}, new URLSearchParams({ period }))
export const useIndicators = (period: string) => useEndpoint(endpoints.indicators, {}, new URLSearchParams({ period }))
export const useIndicatorsNow = () => useEndpoint(endpoints.indicatorsNow)
export const useEvents = (query: URLSearchParams) => useEndpoint(endpoints.events, {}, query)
export const useConventions = () => useEndpoint(endpoints.conventions)
export const useConventionsVersion = (version: string | number) =>
  useEndpoint(endpoints.conventionsVersion, { version })
export const useConventionsDiff = (version: string | number) => useEndpoint(endpoints.conventionsDiff, { version })
export const useQueues = () => useEndpoint(endpoints.queues)
export const useJobs = (query: URLSearchParams) => useEndpoint(endpoints.jobs, {}, query)
export const useRuns = (query: URLSearchParams) => useEndpoint(endpoints.runs, {}, query)
export const useRun = (id: string) => useEndpoint(endpoints.run, { id })
export const useMachines = () => useEndpoint(endpoints.machines)

/** One page of a run's log; `cursor` null is the first page. */
export const fetchRunLogs = (id: string, cursor: number | null) =>
  request<LogPageJson>(
    urlOf(endpoints.runLogs, { id }, cursor === null ? undefined : new URLSearchParams({ cursor: String(cursor) })),
  )

/** The signed-in user, or null when this browser has no valid session. */
export const getSession = (): Promise<SignedIn | null> => request<SignedIn | null>(urlOf(endpoints.session))
export const signIn = (email: string, password: string): Promise<unknown> =>
  request(urlOf(endpoints.signIn), { method: 'POST', body: { email, password } })
export const signOut = (): Promise<unknown> => request(urlOf(endpoints.signOut), { method: 'POST', body: {} })
