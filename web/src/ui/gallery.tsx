import { type ReactNode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { taskTone } from '../lib/tones.ts'
import { ICON_NAMES } from './icons.tsx'
import {
  Badge,
  Banner,
  Bubble,
  Button,
  Card,
  Combobox,
  ComposerShell,
  Dialog,
  Dot,
  EmptyState,
  ErrorBox,
  Field,
  Icon,
  IconButton,
  Input,
  Kanban,
  type KanbanColumn,
  ListCard,
  Loading,
  LogView,
  Menu,
  Mono,
  Pager,
  Popover,
  ProgressBar,
  Ring,
  Segmented,
  Select,
  SortableList,
  Spinner,
  StatStrip,
  Table,
  Textarea,
  ThemeToggle,
  Thread,
  Time,
  ToastProvider,
  Toggle,
  Tooltip,
  useToast,
} from './index.ts'
import './gallery.css'

// Every primitive and pattern with sample props, in dark and light side by side: the review surface for P5-T07's
// "every primitive renders in both themes" and the page the visual gate screenshots. Built to dist/gallery.html by
// web/build.ts; it reads no data. `?theme=dark|light` shows one theme full width (phone screenshots), `?open=dialog`
// opens the dialog, `?open=toast` shows a toast.

const params = new URLSearchParams(location.search)
const OPEN = params.get('open')
const TONES = ['ok', 'info', 'warn', 'danger', 'idle', 'neutral'] as const
const MODELS = [
  { value: 'model-small-1', label: 'Small 1', hint: 'model-small-1' },
  { value: 'model-medium-4', label: 'Medium 4', hint: 'model-medium-4' },
  { value: 'model-large-5', label: 'Large 5', hint: 'model-large-5' },
  { value: 'model-large-5-1', label: 'Large 5.1', hint: 'model-large-5-1' },
]
const LOG = Array.from({ length: 400 }, (_, i) => `[${String(i).padStart(3, '0')}] step ${i % 7} ok in ${i * 3} ms`)
type Task = { key: string; title: string; state: string }
const TASKS: Task[] = [
  { key: 'P5-T06', title: 'Web restructure', state: 'done' },
  { key: 'P5-T07', title: 'Design tokens', state: 'in_progress' },
  { key: 'P5-T08', title: 'Data layer', state: 'blocked' },
  { key: 'P5-T09', title: 'App shell', state: 'todo' },
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="g-section">
      <h2>{title}</h2>
      <div className="g-row">{children}</div>
    </section>
  )
}

function Samples() {
  const [seg, setSeg] = useState<'all' | 'active' | 'offline'>('all')
  const [on, setOn] = useState(true)
  const [dialog, setDialog] = useState(OPEN === 'dialog')
  const [popover, setPopover] = useState(true)
  const [draft, setDraft] = useState('Ship the tokens and')
  const [order, setOrder] = useState(TASKS)
  const [columns, setColumns] = useState<KanbanColumn<Task>[]>([
    { key: 'todo', title: 'To do', items: TASKS.filter((t) => t.state === 'todo' || t.state === 'blocked') },
    { key: 'doing', title: 'Doing', tone: 'info', items: TASKS.filter((t) => t.state === 'in_progress') },
    { key: 'done', title: 'Done', tone: 'ok', items: TASKS.filter((t) => t.state === 'done') },
  ])
  const toast = useToast()
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

  return (
    <>
      <Section title="Button">
        <Button variant="primary" icon="plus">
          New session
        </Button>
        <Button>Default</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger" confirm="Click again to stop">
          Stop run
        </Button>
        <Button size="sm" icon="rotate-cw">
          Retry
        </Button>
        <Button disabled>Disabled</Button>
      </Section>
      <Section title="IconButton">
        <IconButton icon="search" label="Search" />
        <IconButton icon="copy" label="Copy" size="sm" />
        <IconButton icon="x" label="Close" variant="ghost" />
        <IconButton icon="arrow-up" label="Send" variant="primary" />
        <SampleThemeToggle />
      </Section>
      <Section title="Badge and Dot">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} dot>
            {tone}
          </Badge>
        ))}
        <Badge mono>ctx 23%</Badge>
        <Badge tone="danger" notes={['timeout', 'cached']}>
          failed
        </Badge>
        {TONES.map((tone) => (
          <Dot key={tone} tone={tone} live={tone === 'ok'} label={tone} />
        ))}
      </Section>
      <Section title="Card">
        <Card>A surface with a hairline border.</Card>
        <Card selected padding="sm">
          Selected card
        </Card>
      </Section>
      <Section title="Ring and ProgressBar">
        <Ring value={0.23} label="CPU" />
        <Ring value={0.8} tone="warn" label="RAM" />
        <Ring value={0.95} tone="danger" label="Disk" size="sm" />
        <Ring value={0.62} label="Memory" size="lg">
          62%
        </Ring>
        <div className="g-stack">
          <ProgressBar value={0.75} label="Progress" />
          <ProgressBar value={0.4} tone="warn" label="Context" />
          <ProgressBar
            label="Tasks by state"
            segments={TASKS.map((t, i) => ({ key: t.key, value: i + 1, tone: taskTone(t.state), title: t.state }))}
          />
        </div>
      </Section>
      <Section title="Segmented and Toggle">
        <Segmented
          label="Filter"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'all', label: 'All', count: 12 },
            { value: 'active', label: 'Active' },
            { value: 'offline', label: 'Offline' },
          ]}
        />
        <Toggle label="Auto-run" checked={on} onChange={setOn} />
        <Toggle label="Disabled" checked={false} onChange={() => {}} disabled />
      </Section>
      <Section title="Input, Textarea, Select, Field">
        <div className="g-stack">
          <Field label="Name" hint="Shown on the card.">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} placeholder="Session name" />}
          </Field>
          <Field label="Branch" error="DR101 the branch name has a space">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} defaultValue="my branch" invalid />}
          </Field>
          <Textarea mono defaultValue={'devrounds run start check\n--cwd .'} aria-label="Command" />
          <Select
            aria-label="Queue"
            options={[
              { value: 'default', label: 'default' },
              { value: 'heavy', label: 'heavy' },
            ]}
          />
        </div>
      </Section>
      <Section title="Table">
        <Table>
          <thead>
            <tr>
              <th>Run</th>
              <th>State</th>
              <th className="dr-num">Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <Mono>3f9a21c0</Mono>
              </td>
              <td>
                <Badge tone="ok">finished</Badge>
              </td>
              <td className="dr-num">1m 05s</td>
              <td>
                <Time at={minutesAgo(5)} />
              </td>
            </tr>
            <tr>
              <td>
                <Mono>a01b77e2</Mono>
              </td>
              <td>
                <Badge tone="danger" notes={['oom']}>
                  failed
                </Badge>
              </td>
              <td className="dr-num">12.4s</td>
              <td>
                <Time at={minutesAgo(190)} />
              </td>
            </tr>
          </tbody>
        </Table>
      </Section>
      <Section title="Popover, Menu, Tooltip, Combobox">
        <Popover
          open={popover}
          onClose={() => setPopover(false)}
          label="Details"
          anchor={
            <Button size="sm" onClick={() => setPopover(!popover)}>
              Popover
            </Button>
          }
        >
          <div className="g-pop">A floating panel: Esc or a press outside closes it.</div>
        </Popover>
        <Menu
          label="Run actions"
          onSelect={(key) => toast({ text: `Picked ${key}`, tone: 'info' })}
          items={[
            { key: 'retry', label: 'Retry', icon: 'rotate-cw' },
            { key: 'copy', label: 'Copy id', icon: 'copy' },
            { key: 'stop', label: 'Stop', icon: 'square', danger: true },
          ]}
        />
        <Tooltip text="Context used by the session">
          <Badge mono>ctx 23%</Badge>
        </Tooltip>
        <div className="g-combo">
          <Combobox label="Model" items={MODELS} selected="model-large-5" onSelect={() => {}} />
        </div>
      </Section>
      <Section title="Dialog and Toast">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Button
          onClick={() => toast({ text: 'Session renamed', tone: 'ok', action: { label: 'Undo', run: () => {} } })}
        >
          Show toast
        </Button>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Session model"
          subtitle="P5-T07 · now on model-large-5"
          actions={
            <>
              <Button variant="ghost" onClick={() => setDialog(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Save
              </Button>
            </>
          }
        >
          <Combobox label="Model" items={MODELS} selected="model-large-5" onSelect={() => setDialog(false)} />
        </Dialog>
      </Section>
      <Section title="Spinner, EmptyState, Banner, ErrorBox, Loading">
        <Spinner />
        <Spinner size="sm" label="Saving" showLabel />
        <Loading data={null} error={null}>
          never
        </Loading>
        <div className="g-stack">
          <EmptyState title="No runs yet" action={<Button size="sm">Start a run</Button>}>
            Runs appear here when a machine picks up a job.
          </EmptyState>
          <Banner tone="warn">The executor on this machine is behind by 2 versions.</Banner>
          <Banner tone="ok">Gate passed.</Banner>
          <ErrorBox error={{ code: 'DR304', message: 'phase P5 is blocked by P4', hint: 'finish P4 first' }} />
        </div>
      </Section>
      <Section title="Icons">
        {ICON_NAMES.map((name) => (
          <span key={name} className="g-icon" title={name}>
            <Icon name={name} />
          </span>
        ))}
      </Section>
      <Section title="StatStrip">
        <div className="g-stack">
          <StatStrip
            label="Machine"
            stats={[
              { key: 'cpu', label: 'CPU', value: '23%', ring: { value: 0.23 } },
              { key: 'ram', label: 'RAM', value: '75.1', of: '/ 94 GB', ring: { value: 0.8, tone: 'warn' } },
              { key: 'disk', label: 'Docker', value: '2.8 GB', ring: { value: 0.1 } },
            ]}
          />
        </div>
      </Section>
      <Section title="ListCard in a SortableList">
        <div className="g-stack">
          <SortableList
            label="Sessions"
            items={order}
            keyOf={(t) => t.key}
            onReorder={setOrder}
            renderItem={(t, grip) => (
              <ListCard
                grip={grip}
                title={t.key}
                meta={
                  <>
                    <b>{t.state}</b> · <Mono>ctx 17%</Mono> · {t.title}
                  </>
                }
                status={{ tone: taskTone(t.state), live: t.state === 'in_progress', label: t.state }}
                trailing={t.state === 'in_progress' ? '75%' : undefined}
                progress={t.state === 'in_progress' ? { value: 0.75 } : undefined}
                selected={t.key === 'P5-T08'}
                onOpen={() => toast({ text: `Open ${t.key}` })}
              />
            )}
          />
        </div>
      </Section>
      <Section title="Kanban">
        <div className="g-stack">
          <Kanban
            label="Tasks"
            columns={columns}
            keyOf={(t) => t.key}
            onMove={({ key, from, to, index }) =>
              setColumns((all) => {
                const item = all.find((c) => c.key === from)?.items.find((t) => t.key === key)
                if (!item) return all
                const without = all.map((c) => ({ ...c, items: c.items.filter((t) => t.key !== key) }))
                return without.map((c) =>
                  c.key === to ? { ...c, items: [...c.items.slice(0, index), item, ...c.items.slice(index)] } : c,
                )
              })
            }
            renderCard={(t, grip) => (
              <ListCard grip={grip} title={t.key} meta={t.title} status={{ tone: taskTone(t.state), label: t.state }} />
            )}
          />
        </div>
      </Section>
      <Section title="Thread and ComposerShell">
        <div className="g-stack g-chat">
          <Thread label="Conversation">
            <Bubble from="system">Session started</Bubble>
            <Bubble from="me" meta="you · 2m">
              Port the run page onto the primitives.
            </Bubble>
            <Bubble from="them" meta="agent · 1m">
              Done: RunPage now uses Table, Badge and LogView. Two inline styles left for widths.
            </Bubble>
            <Bubble from="me" meta="sending" pending>
              Remove them too.
            </Bubble>
            <Bubble from="me" meta="not sent: DR402" failed>
              And open the PR.
            </Bubble>
          </Thread>
          <ComposerShell
            value={draft}
            onChange={setDraft}
            onSend={() => setDraft('')}
            onAttach={() => {}}
            placeholder="Reply or send a command (/ lists commands)"
          />
        </div>
      </Section>
      <Section title="LogView and Pager">
        <div className="g-stack">
          <LogView label="Run output" lines={LOG} height={180} />
          <LogView label="Empty output" lines={[]} />
          <Pager page={2} next="cursor" onNewer={() => {}} onOlder={() => {}} />
        </div>
      </Section>
    </>
  )
}

// The page shows both themes anyway, so the sample only flips its own icon.
function SampleThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  return <ThemeToggle theme={theme} onChange={setTheme} />
}

function Themed({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <div className="g-theme" data-theme={theme}>
      <h1>{theme}</h1>
      <ToastProvider>
        <ToastOnLoad />
        <Samples />
      </ToastProvider>
    </div>
  )
}

function ToastOnLoad() {
  const toast = useToast()
  const [shown, setShown] = useState(false)
  if (OPEN === 'toast' && !shown) {
    setShown(true)
    queueMicrotask(() => toast({ text: 'Run 3f9a21c0 finished', tone: 'ok', action: { label: 'Open', run: () => {} } }))
  }
  return null
}

const only = params.get('theme')
createRoot(document.getElementById('root') as HTMLElement).render(
  only === 'dark' || only === 'light' ? (
    <div className="g-one">
      <Themed theme={only} />
    </div>
  ) : (
    <div className="g-both">
      <Themed theme="dark" />
      <Themed theme="light" />
    </div>
  ),
)
