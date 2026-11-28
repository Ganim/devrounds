import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { endpoints } from './contract.ts'
import { getProject } from './prefs.ts'

// The one query cache of the tab (P5 design §3 call 4). Its defaults keep what the polling hook did before P5-T08:
// fetch on mount and every 10 s (the P0 exception; P5-T02 swaps the interval for SSE invalidation), show an error at
// once instead of after retries (a DR401 sends the view to the sign-in form), and no extra refetch on focus or
// reconnect. The previous data stays on screen while a refresh is in flight or fails.
export const POLL_MS = 10_000

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchInterval: POLL_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
})

/**
 * The cache key of a resource: project first, so a project switch never shows another project's data and one project's
 * queries invalidate by prefix, then the resource name, so `[project, name]` invalidates every page of a list (what
 * P5-T02 maps a live topic to).
 */
export const queryKeyOf = (
  name: keyof typeof endpoints | 'memberPref',
  params: Record<string, string | number> = {},
  query = '',
) => [getProject(), name, params, query] as const

export const DataProvider = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
