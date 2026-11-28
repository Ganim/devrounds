// The only web file that imports server code, and only its types: erased by esbuild, so the bundle never pulls in the
// control plane. The keys of these types are a contract (see planning/view.ts); boundaries.test.ts keeps every other
// file off control-plane/src, and contract.test.ts fails an endpoint below that has no route on the server.
import type { VersionDiff } from '../../../control-plane/src/conventions/diff-versions.ts'
import type { ConventionsSummary, VersionView } from '../../../control-plane/src/conventions/service.ts'
import type { JobSummary } from '../../../control-plane/src/jobs/enqueue.ts'
import type { MachineView } from '../../../control-plane/src/machines/service.ts'
import type { BalanceRow } from '../../../control-plane/src/planning/balance.ts'
import type {
  CriterionView,
  EventView,
  LinkView,
  PhaseView,
  PlanView,
  TaskView,
} from '../../../control-plane/src/planning/view.ts'
import type { QueueView } from '../../../control-plane/src/queues/service.ts'
import type { IndicatorRow, IndicatorsNow } from '../../../control-plane/src/runs/indicators.ts'
import type { LogLine } from '../../../control-plane/src/runs/log-store.ts'
import type { RunSummary, RunView } from '../../../control-plane/src/runs/view.ts'

export type {
  BalanceRow,
  CriterionView,
  EventView,
  IndicatorRow,
  IndicatorsNow,
  LinkView,
  PhaseView,
  PlanView,
  TaskView,
}

// A server type as it arrives in JSON: every Date is an ISO string.
type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T

export type RunSummaryJson = Wire<RunSummary>
export type RunListJson = { runs: RunSummaryJson[]; nextCursor: string | null }
export type JobListJson = { jobs: Wire<JobSummary>[]; nextCursor: string | null }
export type QueueJson = Wire<QueueView>
// GET /api/machines adds whether the machine has a live session.
export type MachineJson = Wire<MachineView> & { connected: boolean }
export type RunJson = Wire<RunView>
// GET /runs/:id/logs: the cursor is a line seq.
export type LogPageJson = { lines: LogLine[]; nextCursor: number | null }
// GET /conventions, /conventions/:version and /conventions/:version/diff (conventions/service.ts).
export type ConventionsSummaryJson = Wire<ConventionsSummary>
export type ConventionsVersionJson = Wire<VersionView>
export type ConventionsDiffJson = VersionDiff & { version: number; against: number | null }
export type SignedIn = { user: { email: string; name: string } }

/**
 * One API route the web calls. `path` is the server's route pattern (`:name` params); `project` routes live under
 * `/api/projects/:key` and get the selected project's key. `response` is never set: it only carries the type.
 */
export type Endpoint<T> = { method: 'GET' | 'POST'; path: `/${string}`; project: boolean; response?: T }

const get = <T>(path: `/${string}`, project = true): Endpoint<T> => ({ method: 'GET', path, project })
const post = <T>(path: `/${string}`): Endpoint<T> => ({ method: 'POST', path, project: false })

export const PROJECT_PREFIX = '/api/projects/:key'

export const endpoints = {
  plan: get<PlanView>('/plan'),
  balance: get<BalanceRow[]>('/balance'),
  indicators: get<IndicatorRow[]>('/indicators'),
  indicatorsNow: get<IndicatorsNow>('/indicators/now'),
  events: get<EventView[]>('/events'),
  conventions: get<ConventionsSummaryJson>('/conventions'),
  conventionsVersion: get<ConventionsVersionJson>('/conventions/:version'),
  conventionsDiff: get<ConventionsDiffJson>('/conventions/:version/diff'),
  queues: get<QueueJson[]>('/queues'),
  jobs: get<JobListJson>('/jobs'),
  runs: get<RunListJson>('/runs'),
  run: get<RunJson>('/runs/:id'),
  runLogs: get<LogPageJson>('/runs/:id/logs'),
  machines: get<MachineJson[]>('/api/machines', false),
  // Better Auth's routes (auth/session.ts), mounted under /api/auth/*.
  session: get<SignedIn | null>('/api/auth/get-session', false),
  signIn: post<unknown>('/api/auth/sign-in/email'),
  signOut: post<unknown>('/api/auth/sign-out'),
} satisfies Record<string, Endpoint<unknown>>
