import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildServer } from '../../control-plane/src/api/server.ts'
import type { SessionAuth } from '../../control-plane/src/auth/session.ts'
import { endpoints, PROJECT_PREFIX } from './data/contract.ts'

// Why: data/contract.ts declares each route the web calls by hand (no OpenAPI, P5 design §3 call 4), so a route renamed
// or removed on the server would only show as a broken page. This builds the server without listening and without a
// database (routes register without querying) and matches every endpoint against the registered routes.

// A route pattern as a regex over concrete paths: `:name` is one segment, `*` the rest.
const patternOf = (url: string): RegExp =>
  new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+').replace(/\*/g, '.*')}$`)

test('every endpoint of data/contract.ts has a route on the server', async () => {
  // Only the route registration of /api/auth/* is wanted; no request reaches these.
  const sessionAuth: SessionAuth = {
    handler: async () => {},
    userOf: async () => null,
    close: async () => {},
  }
  const app = buildServer({
    db: {} as Parameters<typeof buildServer>[0]['db'],
    logger: false,
    webDir: 'no-web-dir',
    sessionAuth,
  })
  const routes: { method: string; pattern: RegExp }[] = []
  // Plugins load at ready(), so a hook added now sees every route they register.
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, pattern: patternOf(route.url) })
  })
  await app.ready()
  await app.close()

  const missing = Object.entries(endpoints)
    .map(([name, e]) => ({ name, method: e.method, path: e.project ? `${PROJECT_PREFIX}${e.path}` : e.path }))
    .filter(({ method, path }) => {
      // A concrete path: one sample value per param, so a param fits a param and a wildcard.
      const sample = path.replace(/:\w+/g, 'x')
      return !routes.some((r) => r.method === method && r.pattern.test(sample))
    })
    .map(({ name, method, path }) => `${name}: ${method} ${path}`)
  assert.deepEqual(missing, [], 'rename the endpoint in data/contract.ts to the server route, or restore the route')
  assert.ok(routes.length > 0, 'no route registered: the onRoute hook missed the plugins')
})
