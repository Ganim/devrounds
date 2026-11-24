import { fail } from '../errors/error.ts'

/**
 * Checks the depends_on graph of a batch before anything is stored: refs are unique (DR101 at `/jobs/<i>/ref`), every
 * dependency names a job of the batch (DR101 at `/jobs/<i>/depends_on/<j>`), and no job waits on itself through any
 * path (DR152, `cycle` = the refs of one cycle joined by ` → `, ending where it started). A cycle would leave its
 * jobs queued forever, since none of them can ever have its dependencies finished.
 */
export function checkGraph(batch: string, jobs: { ref: string; dependsOn: string[] }[], listPath = '/jobs'): void {
  const index = new Map<string, number>()
  for (const [i, job] of jobs.entries()) {
    const first = index.get(job.ref)
    if (first !== undefined)
      fail('DR101', { path: `${listPath}/${i}/ref`, reason: `ref ${job.ref} is already job ${first}` })
    index.set(job.ref, i)
  }
  for (const [i, job] of jobs.entries()) {
    for (const [j, ref] of job.dependsOn.entries()) {
      if (!index.has(ref))
        fail('DR101', { path: `${listPath}/${i}/depends_on/${j}`, reason: `no job of the batch has ref ${ref}` })
    }
  }
  // Depth-first search; a dependency met again while still on the path closes a cycle.
  const done = new Set<string>()
  const path: string[] = []
  const visit = (ref: string): void => {
    if (done.has(ref)) return
    const at = path.indexOf(ref)
    if (at >= 0) fail('DR152', { batch, cycle: [...path.slice(at), ref].join(' → ') })
    path.push(ref)
    for (const dependency of jobs[index.get(ref) as number].dependsOn) visit(dependency)
    path.pop()
    done.add(ref)
  }
  for (const job of jobs) visit(job.ref)
}
