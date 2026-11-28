import dagre from '@dagrejs/dagre'
import { Background, type Edge, MarkerType, type Node, Position, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo } from 'react'
import type { TaskView } from '../../data/contract.ts'

const NODE = { width: 170, height: 46 }
// Token names, not colors (ui/tokens.css owns every color), so the graph follows the theme.
const COLOR: Record<string, string> = {
  done: 'var(--state-ok)',
  in_progress: 'var(--state-info)',
  blocked: 'var(--state-danger)',
  todo: 'var(--surface-3)',
  cancelled: 'var(--surface-2)',
}

// Tasks of one phase, edge blocker -> blocked task, laid out left to right. A blocker from another phase appears as a
// dashed node with no state, so the cross-phase wait is visible without loading every phase.
export function layoutTasks(tasks: TaskView[]): { nodes: Node[]; edges: Edge[] } {
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  const keys = new Set(tasks.map((t) => t.key))
  for (const t of tasks) for (const b of t.blockedBy) keys.add(b)

  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 70 })
  graph.setDefaultEdgeLabel(() => ({}))
  // dagre writes x/y into the label it is given, so each node needs its own copy of the size.
  for (const key of keys) graph.setNode(key, { ...NODE })
  const edges: Edge[] = []
  for (const t of tasks) {
    for (const b of t.blockedBy) {
      graph.setEdge(b, t.key)
      edges.push({ id: `${b}->${t.key}`, source: b, target: t.key, markerEnd: { type: MarkerType.ArrowClosed } })
    }
  }
  dagre.layout(graph)

  const nodes: Node[] = [...keys].sort().map((key) => {
    const task = byKey.get(key)
    const at = graph.node(key)
    const dark = task !== undefined && task.state !== 'todo' && task.state !== 'cancelled'
    return {
      id: key,
      position: { x: at.x - NODE.width / 2, y: at.y - NODE.height / 2 },
      data: { label: task ? `${key}  ${task.title}` : `${key} (other phase)` },
      style: {
        width: NODE.width,
        height: NODE.height,
        fontSize: 11,
        padding: 4,
        overflow: 'hidden',
        background: task ? COLOR[task.state] : 'var(--surface-1)',
        color: dark ? 'var(--on-state)' : 'var(--text)',
        border: task ? 'none' : '1px dashed var(--text-dim)',
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
    }
  })
  return { nodes, edges }
}

export function DependencyGraph({ tasks }: { tasks: TaskView[] }) {
  const { nodes, edges } = useMemo(() => layoutTasks(tasks), [tasks])
  if (edges.length === 0) return <p className="muted">No dependencies between these tasks.</p>
  return (
    <div className="graph">
      <ReactFlow nodes={nodes} edges={edges} fitView nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background />
      </ReactFlow>
    </div>
  )
}
