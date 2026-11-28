import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampAside } from './aside.ts'
import { hrefOf, matchRoute, NAV, navOf, ROUTES, type RouteName } from './routes.ts'

test('a hash resolves to its route, params and filters', () => {
  const run = matchRoute('#/runs/abc?state=failed')
  assert.equal(run.name, 'run')
  assert.deepEqual(run.params, { id: 'abc' })
  assert.equal(run.query.get('state'), 'failed')
  assert.equal(matchRoute('#/runs?state=failed').name, 'runs')
  assert.equal(matchRoute('').name, 'roadmap')
  assert.deepEqual(matchRoute('#/phase/P%205').params, { key: 'P 5' })
  // Older links keep working until the pages are ported.
  assert.deepEqual(matchRoute('#/run/abc').params, { id: 'abc' })
  assert.equal(matchRoute('#/nowhere').name, null)
  assert.equal(matchRoute('#/phase/%').name, null)
})

test('every route is reachable from the nav, directly or as the detail of a list in it', () => {
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    const lit = navOf(name)
    assert.ok(lit !== null && NAV.some((e) => e.name === lit), `${name} lights no nav entry`)
    const master = ROUTES[name].master
    if (master) assert.equal(ROUTES[master].master, undefined, `${name}: a detail opens beside a list, not a detail`)
  }
  // The phone bar holds at most four entries plus "More" (cx-env: four tabs share the pill).
  assert.ok(NAV.filter((e) => e.phone === 'bar').length <= 4)
})

test('hrefOf builds the hash matchRoute reads back', () => {
  const query = new URLSearchParams({ state: 'failed' })
  const href = hrefOf('run', { id: 'a/b' }, query)
  assert.equal(href, '#/runs/a%2Fb?state=failed')
  assert.deepEqual(matchRoute(href).params, { id: 'a/b' })
  assert.equal(hrefOf('runs'), '#/runs')
})

test('the aside stays between 320 and 720 px and leaves the list its room', () => {
  assert.equal(clampAside(100, 1600), 320)
  assert.equal(clampAside(2000, 1600), 720)
  assert.equal(clampAside(700, 1000), 520)
  assert.equal(clampAside(450.4, 1600), 450)
})
