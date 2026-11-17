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

// P0 exception (AGENTS.md): a pasted API token kept in localStorage instead of a session login (P1).
const TOKEN_KEY = 'devrounds.token'
const PROJECT_KEY = 'devrounds.project'
const POLL_MS = 10_000

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token.trim())
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY)
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

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(getProject())}${path}`, {
    headers: { authorization: `Bearer ${getToken()}` },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ApiError(body?.code ?? 'HTTP', body?.text ?? `HTTP ${response.status}`, body?.hint ?? '')
  }
  return body as T
}

export type Remote<T> = { data: T | null; error: ApiError | null }

// Fetches `path` now and every 10 s (P0 exception; P5 replaces polling with SSE). The previous data stays on screen
// while a refresh is in flight or fails, so a hiccup does not blank the page.
export function useRemote<T>(path: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ data: null, error: null })
  useEffect(() => {
    let live = true
    const load = () =>
      request<T>(path).then(
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
