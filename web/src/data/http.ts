import { type Endpoint, PROJECT_PREFIX } from './contract.ts'
import { getProject } from './prefs.ts'

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

type Method = Endpoint<unknown>['method']

/**
 * Calls the control plane at `url` (an absolute path such as `/api/machines`) with the browser's session cookie and
 * returns the JSON body. No Authorization header is ever sent: the view signs in through Better Auth. A failure throws
 * ApiError; DR401 means the session is gone and the view shows the sign-in form.
 */
export async function request<T>(
  url: string,
  init?: { method: Method; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const json = init?.body !== undefined
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...init?.headers },
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

/**
 * A mutating call to our API (not /api/auth). `action` goes in `x-devrounds-action`: a cookie write needs that custom
 * header, which a cross-site form cannot send (P5 design §3 call 6, P5-T10); until that guard ships, a cookie write
 * answers DR402. Every call gets its own `Idempotency-Key` (AGENTS invariant), so one repeated by the network applies
 * once; writes are never retried by the cache (TanStack Query mutations default to no retry), since a retry with a new
 * key could apply twice.
 */
export const write = <T>(
  url: string,
  { method, action, body }: { method: Exclude<Method, 'GET'>; action: string; body?: unknown },
): Promise<T> =>
  request<T>(url, {
    method,
    body,
    headers: { 'idempotency-key': crypto.randomUUID(), 'x-devrounds-action': action },
  })
