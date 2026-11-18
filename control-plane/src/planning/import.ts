import { fail } from '../errors/error.ts'
import { findIssue, type PlanFile, type PlanFileCriterion, type PlanFileTask } from './plan-file.ts'
import { type Actor, type Ctx, findProject, run, type Target, type Trx } from './resolve.ts'
import { ALLOWED, isPhaseClosable, type TaskState } from './rules.ts'
import {
  addCriterion,
  addDependency,
  addPhase,
  addPhaseDependency,
  addTask,
  checkCriterion,
  closePhase,
  createProject,
  editCriterion,
  editPhase,
  editTask,
  movePhase,
  transition,
} from './service.ts'
import { type CriterionView, getPlan, type PhaseView, type PlanView, type TaskView } from './view.ts'

export type ImportResult = {
  created: string[] // project, phase and task keys
  updated: string[] // phase and task keys that got at least one event
  unchanged: number // phases and tasks in the file that got none
  onlyInDb: string[] // phase and task keys of the project missing from the file
}

const REASON = 'import'
const IMPORT_MEMBER = 'import'

// Upserts by key and never deletes. What the file can no longer express stays as it is: phases and tasks missing
// from the file (reported in onlyInDb), dependency edges and criteria missing from it, a checked criterion listed
// as a plain string, a task's parent (editTask cannot change it), the project name (no editProject yet), and an
// optional task field the file omits (description, assignee, estimate_hours). A task without `state` (or `todo`) and a
// phase without `state: delivered` are never moved back, so re-importing an old seed keeps the progress made since.
//
// Each change goes through the same service call a manual edit uses, so it writes the same event; those calls are
// made only for real differences, which makes a re-import of the same file write nothing.
export function importPlan(ctx: Ctx, file: PlanFile): Promise<ImportResult> {
  const issue = findIssue(file)
  if (issue) fail('DR101', issue)
  // One transaction: any error (DR103 cycle, DR303 done without evidence…) leaves nothing written.
  return run(ctx, async (trx) => {
    const c: Ctx = { ...ctx, trx, actor: await importActor(trx, ctx.tenantId) }
    return new Importer(c, trx, file).run()
  })
}

async function importActor(trx: Trx, tenantId: string): Promise<Actor> {
  await trx
    .insertInto('members')
    .values({ tenant_id: tenantId, kind: 'agent', name: IMPORT_MEMBER })
    .onConflict((oc) => oc.columns(['tenant_id', 'name']).doNothing())
    .execute()
  return trx.selectFrom('members').select(['id', 'kind']).where('name', '=', IMPORT_MEMBER).executeTakeFirstOrThrow()
}

const textOf = (c: PlanFileCriterion) => (typeof c === 'string' ? c : c.text)
const evidenceOf = (c: PlanFileCriterion) => (typeof c === 'string' ? null : c.evidence)

// Shortest path through the allowed moves, e.g. cancelled → todo → in_progress → done.
function pathTo(from: TaskState, to: TaskState): TaskState[] {
  const previous = new Map<TaskState, TaskState>()
  const queue: TaskState[] = [from]
  while (queue.length > 0) {
    const state = queue.shift() as TaskState
    if (state === to) break
    for (const next of ALLOWED[state]) {
      if (next !== from && !previous.has(next)) {
        previous.set(next, state)
        queue.push(next)
      }
    }
  }
  const path: TaskState[] = []
  for (let s: TaskState | undefined = to; s !== undefined && s !== from; s = previous.get(s)) path.unshift(s)
  return path
}

class Importer {
  private readonly created = new Set<string>()
  private readonly touched = new Set<string>()
  private readonly c: Ctx
  private readonly trx: Trx
  private readonly file: PlanFile
  private readonly projectKey: string
  private readonly fileTasks: Array<{ phaseKey: string; task: PlanFileTask }>

  constructor(c: Ctx, trx: Trx, file: PlanFile) {
    this.c = c
    this.trx = trx
    this.file = file
    this.projectKey = file.project.key
    this.fileTasks = file.phases.flatMap((phase) => phase.tasks.map((task) => ({ phaseKey: phase.key, task })))
  }

  async run(): Promise<ImportResult> {
    const { projectKey } = this
    const exists = await this.trx.selectFrom('projects').select('id').where('key', '=', projectKey).executeTakeFirst()
    if (!exists) {
      await createProject(this.c, this.file.project)
      this.created.add(projectKey)
    }
    // Project lock first, so the task and phase locks the service calls take later keep the project → task → phase order.
    const project = await findProject(this.trx, projectKey, { lock: true })

    let plan = await getPlan(this.c, projectKey)
    await this.upsertPhases(plan, project.id)
    await this.upsertTasks(plan)
    plan = await getPlan(this.c, projectKey)
    await this.addEdges(plan)
    plan = await getPlan(this.c, projectKey)
    await this.syncCriteria(plan)
    // A phase the file delivers that is closable already closes before the task states: no task transition would
    // deliver it, and a task of a phase it blocks could not start (DR304).
    await this.deliverPhases((p) =>
      isPhaseClosable({
        states: p.tasks.map((t) => t.state),
        openCriteria: p.criteria.filter((c) => !c.checked).length,
      }),
    )
    plan = await getPlan(this.c, projectKey)
    await this.applyTaskStates(plan)
    await this.deliverPhases()

    const inFile = new Set([...this.file.phases.map((p) => p.key), ...this.fileTasks.map((t) => t.task.key)])
    const updated = [...this.touched].filter((key) => !this.created.has(key)).sort()
    const createdInFile = [...this.created].filter((key) => inFile.has(key)).length
    return {
      created: [...this.created].sort(),
      updated,
      unchanged: inFile.size - createdInFile - updated.length,
      onlyInDb: [...plan.phases.map((p) => p.key), ...allTasks(plan).map((t) => t.key)]
        .filter((key) => !inFile.has(key))
        .sort(),
    }
  }

  private async upsertPhases(plan: PlanView, projectId: string): Promise<void> {
    const { c, projectKey } = this
    const current = new Map(plan.phases.map((p) => [p.key, p]))
    for (const phase of this.file.phases) {
      const db = current.get(phase.key)
      if (!db) {
        const criteria = (phase.criteria ?? []).map(textOf)
        await addPhase(c, { projectKey, key: phase.key, title: phase.title, goal: phase.goal, criteria })
        this.created.add(phase.key)
        continue
      }
      const changes = {
        ...(db.title !== phase.title && { title: phase.title }),
        ...(db.goal !== phase.goal && { goal: phase.goal }),
      }
      if (Object.keys(changes).length > 0) {
        await editPhase(c, { projectKey, phaseKey: phase.key, ...changes, reason: REASON })
        this.touched.add(phase.key)
      }
    }
    // Position = order in the file. Phases only in the database end up after the ones the file places before them.
    for (const [index, phase] of this.file.phases.entries()) {
      const order = await this.trx
        .selectFrom('phases')
        .select('key')
        .where('project_id', '=', projectId)
        .orderBy('position')
        .orderBy('key')
        .execute()
      if (order[index]?.key === phase.key) continue
      await movePhase(c, { projectKey, phaseKey: phase.key, position: index + 1, reason: REASON })
      this.touched.add(phase.key)
    }
  }

  private async upsertTasks(plan: PlanView): Promise<void> {
    const { c, projectKey } = this
    const current = new Map(
      [
        ...plan.phases.flatMap((p) => p.tasks.map((t) => ({ phaseKey: p.key as string | null, t }))),
        ...plan.unphased.map((t) => ({ phaseKey: null, t })),
      ].map((entry) => [entry.t.key, entry]),
    )
    for (const { phaseKey, task } of this.fileTasks) {
      const db = current.get(task.key)
      if (!db) continue
      const changes = {
        ...(db.t.title !== task.title && { title: task.title }),
        ...(task.description !== undefined &&
          db.t.description !== task.description && { description: task.description }),
        ...(db.phaseKey !== phaseKey && { phaseKey }),
        ...(task.assignee !== undefined && db.t.assignee !== task.assignee && { assigneeName: task.assignee }),
        ...(task.estimate_hours !== undefined &&
          db.t.estimateHours !== task.estimate_hours && { estimateHours: task.estimate_hours }),
      }
      if (Object.keys(changes).length > 0) {
        await editTask(c, { projectKey, taskKey: task.key, ...changes, reason: REASON })
        this.touched.add(task.key)
      }
    }
    // addTask needs the parent to exist, and a file may list a child before its parent.
    const pending = this.fileTasks.filter(({ task }) => !current.has(task.key))
    while (pending.length > 0) {
      const waiting = new Set(pending.map(({ task }) => task.key))
      const index = pending.findIndex(({ task }) => task.parent === undefined || !waiting.has(task.parent))
      if (index === -1) fail('DR101', { path: '/phases', reason: `parent cycle among ${[...waiting].join(', ')}` })
      const [{ phaseKey, task }] = pending.splice(index, 1)
      await addTask(c, {
        projectKey,
        phaseKey,
        key: task.key,
        title: task.title,
        description: task.description,
        parentKey: task.parent,
        assigneeName: task.assignee,
        estimateHours: task.estimate_hours,
        criteria: (task.criteria ?? []).map(textOf),
      })
      this.created.add(task.key)
    }
  }

  // Edges go in one by one through addDependency, whose cycle check refuses the edge that closes a cycle (DR103).
  private async addEdges(plan: PlanView): Promise<void> {
    const { c, projectKey } = this
    const phaseBlockers = new Map(plan.phases.map((p) => [p.key, p.blockedBy]))
    for (const phase of this.file.phases) {
      for (const blockedByKey of new Set(phase.blocked_by ?? [])) {
        if (phaseBlockers.get(phase.key)?.includes(blockedByKey)) continue
        await addPhaseDependency(c, { projectKey, phaseKey: phase.key, blockedByKey, reason: REASON })
        this.touched.add(phase.key)
      }
    }
    const taskBlockers = new Map(allTasks(plan).map((t) => [t.key, t.blockedBy]))
    for (const { task } of this.fileTasks) {
      for (const blockedByKey of new Set(task.blocked_by ?? [])) {
        if (taskBlockers.get(task.key)?.includes(blockedByKey)) continue
        await addDependency(c, { projectKey, taskKey: task.key, blockedByKey, reason: REASON })
        this.touched.add(task.key)
      }
    }
  }

  private async syncCriteria(plan: PlanView): Promise<void> {
    const phases = new Map(plan.phases.map((p) => [p.key, p.criteria]))
    const tasks = new Map(allTasks(plan).map((t) => [t.key, t.criteria]))
    for (const phase of this.file.phases) {
      await this.syncCriteriaOf(
        { projectKey: this.projectKey, phaseKey: phase.key },
        phases.get(phase.key) ?? [],
        phase.criteria,
      )
    }
    for (const { task } of this.fileTasks) {
      await this.syncCriteriaOf(
        { projectKey: this.projectKey, taskKey: task.key },
        tasks.get(task.key) ?? [],
        task.criteria,
      )
    }
  }

  // Matched by position: the n-th criterion in the file is the criterion at position n.
  private async syncCriteriaOf(target: Target, db: CriterionView[], file: PlanFileCriterion[] = []): Promise<void> {
    const label = (target.taskKey ?? target.phaseKey) as string
    for (const [index, criterion] of file.entries()) {
      const position = index + 1
      const current = db.find((d) => d.position === position)
      const text = textOf(criterion)
      const evidence = evidenceOf(criterion)
      if (!current) await addCriterion(this.c, { ...target, text })
      else if (current.text !== text) await editCriterion(this.c, { ...target, position, text, reason: REASON })
      if (evidence !== null && current?.evidence !== evidence) {
        await checkCriterion(this.c, { ...target, position, evidence })
      }
      if (!current || current.text !== text || (evidence !== null && current.evidence !== evidence)) {
        this.touched.add(label)
      }
    }
  }

  // Blockers first: a task's blocking tasks, and every task of the phases its phase is blocked by (DR304 otherwise).
  private async applyTaskStates(plan: PlanView): Promise<void> {
    const byKey = new Map(allTasks(plan).map((t) => [t.key, t]))
    const phaseOf = new Map(plan.phases.flatMap((p) => p.tasks.map((t) => [t.key, p.key])))
    const tasksOfPhase = new Map(plan.phases.map((p) => [p.key, p.tasks.map((t) => t.key)]))
    const phaseBlockers = new Map(plan.phases.map((p) => [p.key, p.blockedBy]))
    const blockersOf = (key: string): string[] => {
      const phaseKey = phaseOf.get(key)
      const viaPhases = phaseKey ? (phaseBlockers.get(phaseKey) ?? []).flatMap((p) => tasksOfPhase.get(p) ?? []) : []
      return [...(byKey.get(key)?.blockedBy ?? []), ...viaPhases]
    }
    const order: string[] = []
    const seen = new Set<string>()
    const visit = (key: string) => {
      if (seen.has(key)) return
      seen.add(key)
      for (const blocker of blockersOf(key)) visit(blocker)
      order.push(key)
    }
    for (const { task } of this.fileTasks) visit(task.key)

    const wanted = new Map(this.fileTasks.map(({ task }) => [task.key, task]))
    for (const key of order) {
      const task = wanted.get(key)
      const from = byKey.get(key)?.state
      if (!task?.state || task.state === 'todo' || !from || from === task.state) continue
      let state = from
      for (const to of pathTo(from, task.state)) {
        // The file's reason belongs to blocked/cancelled; leaving done or cancelled on the way needs one too.
        const reason =
          to === 'blocked' || to === 'cancelled'
            ? task.reason
            : state === 'done' || state === 'cancelled'
              ? REASON
              : undefined
        await transition(this.c, { projectKey: this.projectKey, taskKey: key, to, reason })
        state = to
      }
      this.touched.add(key)
    }
  }

  // Last, and only for phases the automatic delivery has not already delivered; `ready` narrows the earlier pass.
  private async deliverPhases(ready: (phase: PhaseView) => boolean = () => true): Promise<void> {
    const plan = await getPlan(this.c, this.projectKey)
    const current = new Map(plan.phases.map((p) => [p.key, p]))
    for (const phase of this.file.phases) {
      const db = current.get(phase.key)
      if (phase.state !== 'delivered' || !db || db.state === 'delivered' || !ready(db)) continue
      await closePhase(this.c, { projectKey: this.projectKey, phaseKey: phase.key })
      this.touched.add(phase.key)
    }
  }
}

function allTasks(plan: PlanView): TaskView[] {
  return [...plan.phases.flatMap((p) => p.tasks), ...plan.unphased]
}
