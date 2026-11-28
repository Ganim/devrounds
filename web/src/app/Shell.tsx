import { type ReactNode, useState } from 'react'
import { shortId } from '../lib/format.ts'
import { ASIDE_DEFAULT, ASIDE_KEY, clampAside, savedAside } from './aside.ts'
import { CLOSE_ICON, MORE_ICON, NAV_ICONS, SIGN_OUT_ICON } from './icons.tsx'
import { useEscapeLayer } from './layers.ts'
import { hrefOf, NAV, type NavEntry, navOf, ROUTES, type Route, type RouteName } from './routes.ts'
import './shell.css'

// The shell, same split as the cx-env panel (page-v2.html `.app`, P5 design §3 call 9): from 900 px a left rail, the
// main column and, when a detail is selected, a resizable aside; below it the main column, a floating bottom bar with
// a "More" sheet, and the detail in a bottom sheet. The detail is one element either way; CSS moves it.

// The last filters seen on each list, so a detail opened from a link without them (#/run/<id> from Jobs) still shows
// the list as the reader left it. Per page load, like cx-env's per-tab memory.
const lastQuery = new Map<RouteName, string>()

export type ShellProps = {
  route: Route
  render: (route: Route) => ReactNode
  project: string
  summary: string
  onSignOut: () => void
}

export function Shell({ route, render, project, summary, onSignOut }: ShellProps) {
  const name = route.name ?? 'roadmap'
  const master = ROUTES[name].master
  const [aside, setAside] = useState(savedAside)
  const [more, setMore] = useState(false)

  let main: Route = route
  if (master) {
    const query = route.query.size > 0 ? route.query : new URLSearchParams(lastQuery.get(master) ?? '')
    main = { name: master, params: {}, query }
  } else {
    lastQuery.set(name, route.query.toString())
  }
  const mainName = main.name ?? 'roadmap'
  const active = navOf(name) ?? 'roadmap'

  return (
    <div className={`app-shell${master ? ' has-detail' : ''}`} style={{ ['--aside' as string]: `${aside}px` }}>
      <nav className="app-rail" aria-label="Main">
        <a className="app-logo" href="#/" title={project}>
          {initials(project)}
        </a>
        {NAV.map((entry, i) => (
          <RailLink
            key={entry.name}
            entry={entry}
            on={entry.name === active}
            divided={i > 0 && NAV[i - 1].group !== entry.group}
          />
        ))}
        <span className="app-spacer" />
        <button type="button" className="app-navbtn" onClick={onSignOut} title="Sign out">
          <span className="app-ico">{SIGN_OUT_ICON}</span>
          Sign out
        </button>
      </nav>

      <main className="app-main">
        <header className="app-title">
          <div className="app-heading">
            <div className="app-project">{project}</div>
            <h1>{ROUTES[mainName].title}</h1>
          </div>
          <span className="app-summary">{summary}</span>
        </header>
        {render(main)}
      </main>

      {master ? (
        <Detail
          title={detailTitle(name, route.params)}
          closeHref={hrefOf(master, {}, main.query)}
          width={aside}
          onWidth={setAside}
        >
          {render(route)}
        </Detail>
      ) : null}

      <nav className="app-tabs" aria-label="Main">
        {NAV.filter((e) => e.phone === 'bar').map((entry) => (
          <RailLink key={entry.name} entry={entry} on={entry.name === active} />
        ))}
        <button
          type="button"
          className={`app-navbtn${NAV.some((e) => e.phone === 'more' && e.name === active) ? ' on' : ''}`}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <span className="app-ico">{MORE_ICON}</span>
          More
        </button>
      </nav>
      {more ? <MoreSheet active={active} onClose={() => setMore(false)} onSignOut={onSignOut} /> : null}
    </div>
  )
}

function RailLink({ entry, on, divided = false }: { entry: NavEntry; on: boolean; divided?: boolean }) {
  return (
    <>
      {divided ? <hr className="app-navsep" /> : null}
      <a className={`app-navbtn${on ? ' on' : ''}`} href={hrefOf(entry.name)} aria-current={on ? 'page' : undefined}>
        <span className="app-ico">{NAV_ICONS[entry.name]}</span>
        {entry.label}
      </a>
    </>
  )
}

/** "DevRounds" -> "DR", "my project" -> "MP": word or camel-case starts, else the first two letters. */
function initials(name: string): string {
  const starts = name.match(/\b\w|[A-Z]/g) ?? []
  return (starts.length >= 2 ? starts.slice(0, 2).join('') : name.slice(0, 2)).toUpperCase() || 'DR'
}

function detailTitle(name: RouteName, params: Record<string, string>): string {
  if (name === 'run') return `Run ${shortId(params.id ?? '')}`
  return [ROUTES[name].title, ...Object.values(params)].join(' ')
}

/** The selected item: the aside from 900 px (drag its left edge, double-click to reset), a bottom sheet below. */
function Detail(props: {
  title: string
  closeHref: string
  width: number
  onWidth: (width: number) => void
  children: ReactNode
}) {
  const close = () => {
    location.hash = props.closeHref
  }
  useEscapeLayer(close)
  return (
    <>
      <button type="button" className="app-backdrop" aria-label="Close" tabIndex={-1} onClick={close} />
      <aside className="app-aside" aria-label={props.title}>
        <Resizer onWidth={props.onWidth} />
        <div className="app-handle" />
        <header className="app-aside-head">
          <h2>{props.title}</h2>
          <a className="app-iconbtn" href={props.closeHref} aria-label="Close" title="Close (Esc)">
            {CLOSE_ICON}
          </a>
        </header>
        <div className="app-aside-body">{props.children}</div>
      </aside>
    </>
  )
}

function Resizer({ onWidth }: { onWidth: (width: number) => void }) {
  return (
    <button
      type="button"
      className="app-resizer"
      aria-label="Resize the panel"
      title="Drag to resize, double-click to reset"
      tabIndex={-1}
      onPointerDown={(e) => {
        e.preventDefault()
        const target = e.currentTarget
        target.setPointerCapture(e.pointerId)
        target.classList.add('on')
        let width = 0
        const move = (ev: PointerEvent) => {
          width = clampAside(innerWidth - ev.clientX, innerWidth)
          onWidth(width)
        }
        const stop = () => {
          target.removeEventListener('pointermove', move)
          target.classList.remove('on')
          if (width > 0) localStorage.setItem(ASIDE_KEY, String(width))
        }
        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', stop, { once: true })
        target.addEventListener('pointercancel', stop, { once: true })
      }}
      onDoubleClick={() => {
        localStorage.removeItem(ASIDE_KEY)
        onWidth(ASIDE_DEFAULT)
      }}
    />
  )
}

/** Phone only: the nav entries that do not fit the bottom bar, and sign out. */
function MoreSheet({ active, onClose, onSignOut }: { active: RouteName; onClose: () => void; onSignOut: () => void }) {
  useEscapeLayer(onClose)
  return (
    <>
      <button type="button" className="app-backdrop app-more-backdrop" aria-label="Close" onClick={onClose} />
      <div className="app-sheet app-more" role="dialog" aria-label="More">
        <div className="app-handle" />
        {NAV.filter((e) => e.phone === 'more').map((entry) => (
          <a
            key={entry.name}
            className={`app-moreitem${entry.name === active ? ' on' : ''}`}
            href={hrefOf(entry.name)}
            onClick={onClose}
          >
            <span className="app-ico">{NAV_ICONS[entry.name]}</span>
            {entry.label}
          </a>
        ))}
        <hr className="app-navsep" />
        <button type="button" className="app-moreitem" onClick={onSignOut}>
          <span className="app-ico">{SIGN_OUT_ICON}</span>
          Sign out
        </button>
      </div>
    </>
  )
}
