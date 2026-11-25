import { type ConventionsDiffJson, type ConventionsSummaryJson, type ConventionsVersionJson, useRemote } from './api.ts'
import { bySection, diffEntries } from './conventions.ts'
import { Loading, when } from './ui.tsx'

type Rule = ConventionsVersionJson['document']['rules'][number]

const uniquePaths = (item: Pick<Rule, 'evidence'>): string[] => [...new Set(item.evidence.map((e) => e.path))]

function ActiveVersion() {
  const view = useRemote<ConventionsVersionJson>('/conventions/active')
  const v = view.data
  return (
    <Loading data={v} error={view.error}>
      {v ? (
        <>
          <h2>
            Version {v.version} <span className="pill active">active</span>
          </h2>
          <p className="muted">
            Approved by {v.decidedBy} at {when(v.decidedAt)} · proposed by {v.proposedBy} for {v.task} · sha{' '}
            <span className="mono">{v.documentSha.slice(0, 12)}</span> · rendered into{' '}
            <span className="mono">{v.document.targets.map((t) => t.path).join(', ')}</span>
          </p>
          {bySection(v.document.rules).map(([section, rules]) => (
            <div key={section}>
              <h2>{section}</h2>
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Kind</th>
                    <th>Severity</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <strong>{r.title}</strong> <span className="mono muted">{r.key}</span>
                        <div className="muted">{r.why}</div>
                      </td>
                      <td>
                        {r.check.kind}
                        {r.check.kind === 'job_type' ? <div className="mono muted">{r.check.enforced_by}</div> : null}
                      </td>
                      <td>
                        {/* A stored document keeps what was proposed; an omitted severity is warn (conventions/file.ts). */}
                        <span className={`pill ${r.severity ?? 'warn'}`}>{r.severity ?? 'warn'}</span>
                      </td>
                      <td className="evidence">
                        {uniquePaths(r).map((path) => (
                          <div key={path}>{path}</div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {v.document.rules.length === 0 ? <p className="muted">No rules.</p> : null}
          {bySection(v.document.facts ?? []).map(([section, facts]) => (
            <div key={`fact ${section}`}>
              <h2>{section}</h2>
              <table>
                <thead>
                  <tr>
                    <th>Fact</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map((f) => (
                    <tr key={f.key}>
                      <td>
                        {f.text} <span className="mono muted">{f.key}</span>
                      </td>
                      <td className="evidence">
                        {uniquePaths(f).map((path) => (
                          <div key={path}>{path}</div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      ) : null}
    </Loading>
  )
}

function Proposal({
  proposal,
  active,
}: {
  proposal: NonNullable<ConventionsSummaryJson['proposal']>
  active: number | null
}) {
  const diff = useRemote<ConventionsDiffJson>(`/conventions/${proposal.version}/diff`)
  const d = diff.data
  const entries = d ? diffEntries(d) : []
  return (
    <>
      <h2>
        Proposal {proposal.version} <span className="pill proposed">proposed</span>
      </h2>
      <p className="muted">
        Proposed by {proposal.proposedBy} for {proposal.task} at {when(proposal.proposedAt)}, based on{' '}
        {proposal.basedOn === null ? 'no version' : `version ${proposal.basedOn}`}.
      </p>
      {proposal.basedOn !== active ? (
        <div className="error">
          Based on {proposal.basedOn === null ? 'no version' : `version ${proposal.basedOn}`}, but{' '}
          {active === null ? 'none' : `version ${active}`} is active: approving answers DR310. Propose again from the
          active version.
        </div>
      ) : null}
      <div className="card">
        Approve with a human token (the web view only reads):
        <pre className="command">
          DEVROUNDS_TOKEN=&lt;human token&gt; devrounds conventions approve {proposal.version}
        </pre>
        or reject with{' '}
        <span className="mono">devrounds conventions reject {proposal.version} --reason &lt;text&gt;</span>.
      </div>
      <Loading data={d} error={diff.error}>
        {d ? (
          <>
            <p className="muted">
              Against {d.against === null ? 'an empty document' : `version ${d.against}`}: {d.added.length} added,{' '}
              {d.removed.length} removed, {d.changed.length} changed.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Item</th>
                  <th>Severity</th>
                  <th>Fields</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={`${e.verb} ${e.key}`}>
                    <td>{e.blocking && e.verb !== 'added' ? <strong>{e.verb}</strong> : e.verb}</td>
                    <td>
                      {e.item} <span className="mono">{e.key}</span>
                    </td>
                    <td>{e.severity ? <span className={`pill ${e.severity}`}>{e.severity}</span> : null}</td>
                    <td className="mono muted">{e.fields.join(', ')}</td>
                  </tr>
                ))}
                {d.targets.added.map((path) => (
                  <tr key={`added target ${path}`}>
                    <td>added</td>
                    <td>
                      target <span className="mono">{path}</span>
                    </td>
                    <td />
                    <td />
                  </tr>
                ))}
                {d.targets.removed.map((path) => (
                  <tr key={`removed target ${path}`}>
                    <td>removed</td>
                    <td>
                      target <span className="mono">{path}</span>
                    </td>
                    <td />
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </Loading>
    </>
  )
}

// Read-only (design call 3): approving stays in the CLI with a human token, so the page prints the command instead.
export function ConventionsPage() {
  const summary = useRemote<ConventionsSummaryJson>('/conventions')
  const s = summary.data
  return (
    <Loading data={s} error={summary.error}>
      {s?.proposal ? <Proposal proposal={s.proposal} active={s.active?.version ?? null} /> : null}
      {s?.active ? <ActiveVersion /> : null}
      {s && !s.active ? <p className="muted">No active conventions version yet.</p> : null}
    </Loading>
  )
}
