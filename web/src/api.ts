import { useEffect, useState } from 'react'
// Types only: erased by esbuild, so the web bundle never pulls in server code. Keys are a contract (see view.ts).
import type { BalanceRow } from '../../control-plane/src/planning/balance.ts'
import type {
  CriterionView,
  EventView,
  LinkView,
  PhaseView,
  PlanView,
  TaskView,
} from '../../control-plane/src/planning/view.ts'

export type { BalanceRow, CriterionView, EventView, LinkView, PhaseView, PlanView, TaskView }

const PROJECT_KEY = 'devrounds.project'
const POLL_MS = 10_000

export const getProject = (): string => localStorage.getItem(PROJECT_KEY) ?? 'devrounds'
export const setProject = (key: string): void => localStorage.setItem(PROJECT_KEY, key.trim() || 'devrounds')

export class ApiError extends Error {
  code: string
  hint: string
  constructor(code: string, text: string, hint: string) {
    super(text)
    this.code = code
    this.hint = hint
  }
}

/**
 * Calls the control plane at `url` (an absolute path such as `/api/machines`) with the browser's session cookie and
 * returns the JSON body. No Authorization header is ever sent: the view signs in through Better Auth, and the cookie
 * only reads (anything but GET answers DR402 outside `/api/auth`). A failure throws ApiError; DR401 means the session
 * is gone and the view shows the sign-in form.
 */
export async function request<T>(url: string, init?: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const json = init?.body !== undefined
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: json ? { 'content-type': 'application/json' } : undefined,
    body: json ? JSON.stringify(init.body) : undefined,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // Our errors carry text and hint; Better Auth's (under /api/auth) carry a message.
    const text = body?.text ?? body?.message ?? `HTTP ${response.status}`
    throw new ApiError(body?.code ?? 'HTTP', text, body?.hint ?? '')
  }
  return body as T
}

/** `path` under the selected project's API, e.g. `projectUrl('/plan')`. */
export const projectUrl = (path: string): string => `/api/projects/${encodeURIComponent(getProject())}${path}`

export type SignedIn = { user: { email: string; name: string } }

/** The signed-in user, or null when this browser has no valid session. */
export const getSession = (): Promise<SignedIn | null> => request<SignedIn | null>('/api/auth/get-session')
export const signIn = (email: string, password: string): Promise<unknown> =>
  request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } })
export const signOut = (): Promise<unknown> => request('/api/auth/sign-out', { method: 'POST', body: {} })

export type Remote<T> = { data: T | null; error: ApiError | null }

// Fetches `path` of the selected project now and every 10 s (P0 exception; P5 replaces polling with SSE). The previous
// data stays on screen while a refresh is in flight or fails, so a hiccup does not blank the page.
export function useRemote<T>(path: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null })
  useEffect(() => {
    let live = true
    const load = () =>
      request<T>(projectUrl(path)).then(
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
  }, [path])
  return state
}
