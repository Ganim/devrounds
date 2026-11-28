import { type Endpoint, PROJECT_PREFIX } from './contract.ts'

const PROJECT_KEY = 'devrounds.project'

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
 * The URL of `endpoint`: its `:name` params filled from `params`, under the selected project's API when it is a project
 * route, and `?query` when a query is given (even an empty one, as the list pages always pass theirs).
 */
export function urlOf(
  endpoint: Endpoint<unknown>,
  params: Record<string, string | number> = {},
  query?: URLSearchParams,
): string {
  const filled = endpoint.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(params[name])))
  const path = endpoint.project
    ? `${PROJECT_PREFIX.replace(':key', encodeURIComponent(getProject()))}${filled}`
    : filled
  return query === undefined ? path : `${path}?${query}`
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
