import { type QueryKey, useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type Endpoint, endpoints, type LogPageJson, type PrefJson, type SignedIn } from './contract.ts'
import { type ApiError, request, urlOf, write } from './http.ts'
import { queryClient, queryKeyOf } from './query.tsx'

// Features read and write the API only through the hooks below; they never import the query library (checked by
// boundaries.test.ts), so the cache can change without touching a page.

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

type Endpoints = typeof endpoints
type ResponseOf<E> = E extends Endpoint<infer T> ? T : never

// One GET endpoint through the cache, polled by the client's defaults (query.tsx).
function useEndpoint<N extends keyof Endpoints>(
  name: N,
  params: Record<string, string | number> = {},
  query?: URLSearchParams,
): Remote<ResponseOf<Endpoints[N]>> {
  const url = urlOf(endpoints[name], params, query)
  const result = useQuery({
    queryKey: queryKeyOf(name, params, query?.toString()),
    queryFn: () => request<ResponseOf<Endpoints[N]>>(url),
  })
  return { data: result.data ?? null, error: result.error as ApiError | null }
}

export const usePlan = () => useEndpoint('plan')
export const useBalance = (period: string) => useEndpoint('balance', {}, new URLSearchParams({ period }))
export const useIndicators = (period: string) => useEndpoint('indicators', {}, new URLSearchParams({ period }))
export const useIndicatorsNow = () => useEndpoint('indicatorsNow')
export const useEvents = (query: URLSearchParams) => useEndpoint('events', {}, query)
export const useConventions = () => useEndpoint('conventions')
export const useConventionsVersion = (version: string | number) => useEndpoint('conventionsVersion', { version })
export const useConventionsDiff = (version: string | number) => useEndpoint('conventionsDiff', { version })
export const useQueues = () => useEndpoint('queues')
export const useJobs = (query: URLSearchParams) => useEndpoint('jobs', {}, query)
export const useRuns = (query: URLSearchParams) => useEndpoint('runs', {}, query)
export const useRun = (id: string) => useEndpoint('run', { id })
export const useMachines = () => useEndpoint('machines')

const fetchRunLogs = (id: string, cursor: number | null) =>
  request<LogPageJson>(
    urlOf(endpoints.runLogs, { id }, cursor === null ? undefined : new URLSearchParams({ cursor: String(cursor) })),
  )

/**
 * A run's log: the first page, then one more page per `more()` (GET /runs/:id/logs?cursor=<nextCursor>). Not polled
 * and outside the cache: a running run's output grows, so its last page offers `more` again from the line after the
 * last one shown. P5-T02 replaces this with the live tail.
 */
export function useRunLog(runId: string, ended: boolean) {
  const [lines, setLines] = useState<LogPageJson['lines']>([])
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  // A new object per ask, so asking again from the same seq (a running run with nothing new yet) fetches again.
  const [ask, setAsk] = useState<{ cursor: number | null }>({ cursor: null })

  // `cursor` null: the first page, replacing what is shown; otherwise the page from that seq, appended.
  useEffect(() => {
    const { cursor } = ask
    let live = true
    setLoading(true)
    fetchRunLogs(runId, cursor).then(
      (page) => {
        if (!live) return
        setLines((shown) => (cursor === null ? page.lines : [...shown, ...page.lines]))
        setNext(page.nextCursor)
        setError(null)
        setLoading(false)
      },
      (err: ApiError) => {
        if (!live) return
        setError(err)
        setLoading(false)
      },
    )
    return () => {
      live = false
    }
  }, [runId, ask])

  const last = lines.at(-1)
  const lastSeq = useRef<number | null>(null)
  lastSeq.current = last?.seq ?? null
  // The run ended after the last fetch: its last lines (often the error) came since, and once it has ended "more"
  // is no longer offered, so they are fetched once, from the line after the last one shown.
  const wasEnded = useRef(ended)
  useEffect(() => {
    if (ended && !wasEnded.current) setAsk({ cursor: lastSeq.current === null ? null : lastSeq.current + 1 })
    wasEnded.current = ended
  }, [ended])

  // A running run has no nextCursor once everything stored is shown; its next lines start after the last seq shown.
  const cursor = next ?? (ended ? null : last ? last.seq + 1 : 0)
  return {
    lines,
    error,
    loading,
    more: cursor === null ? null : () => setAsk({ cursor }),
  }
}

/**
 * A write with an optimistic update: `apply` sets the cached value of `optimistic.key` before `send` answers, and a
 * failure puts the previous value back (the cx-env panel shows the revert, `cxenv-03c-tasks-reverted.png`). `refresh`
 * keys are refetched once the write settles, success or not, so the screen ends on the server's state.
 */
export function useWrite<V, R, D>({
  send,
  optimistic,
  refresh = [],
}: {
  send: (vars: V) => Promise<R>
  optimistic?: { key: QueryKey; apply: (current: D | undefined, vars: V) => D }
  refresh?: QueryKey[]
}) {
  const mutation = useMutation({
    mutationFn: send,
    onMutate: async (vars: V) => {
      if (!optimistic) return undefined
      // A refetch in flight would overwrite the optimistic value with the old one.
      await queryClient.cancelQueries({ queryKey: optimistic.key })
      const previous = queryClient.getQueryData<D>(optimistic.key)
      queryClient.setQueryData<D>(optimistic.key, (current) => optimistic.apply(current, vars))
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (optimistic && context) queryClient.setQueryData(optimistic.key, context.previous)
    },
    onSettled: () => Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  })
  return { write: mutation.mutateAsync, pending: mutation.isPending, error: mutation.error as ApiError | null }
}

// Member prefs live on the server per member and project (P5-T11, design §3 call 8), so they follow the member to
// every device. The pref name is `key` here.
const readPref = async <T>(key: string): Promise<T | null> =>
  (await request<PrefJson>(urlOf(endpoints.pref, { name: key }))).value as T | null
const sendPref = async <T>(key: string, value: T): Promise<void> => {
  await write(urlOf(endpoints.setPref, { name: key }), { method: 'PUT', action: 'pref.set', body: { value } })
}

/**
 * A member-shared preference (card order, custom names, sections, board columns): opaque JSON per key, `fallback` until
 * one is saved. `set` shows the new value at once and puts the previous one back when saving fails.
 */
export function useMemberPref<T>(key: string, fallback: T) {
  const queryKey = queryKeyOf('memberPref', { key })
  const pref = useQuery({
    queryKey,
    queryFn: () => readPref<T>(key),
    refetchInterval: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const save = useWrite<T, void, T | null>({
    send: (value) => sendPref(key, value),
    optimistic: { key: queryKey, apply: (_, value) => value },
  })
  return { value: pref.data ?? fallback, set: save.write, error: (pref.error as ApiError | null) ?? save.error }
}

/** The signed-in user, or null when this browser has no valid session. */
export const getSession = (): Promise<SignedIn | null> => request<SignedIn | null>(urlOf(endpoints.session))

// Signing in or out drops the cache, so the next member never sees what the previous session read.
export const signIn = (email: string, password: string): Promise<unknown> =>
  request(urlOf(endpoints.signIn), { method: 'POST', body: { email, password } }).then((answer) => {
    queryClient.clear()
    return answer
  })
export const signOut = (): Promise<unknown> =>
  request(urlOf(endpoints.signOut), { method: 'POST', body: {} }).finally(() => queryClient.clear())
