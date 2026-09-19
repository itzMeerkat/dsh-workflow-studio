/** Browser-side workflow editing helpers used by the visual editor. */

import { topologicalLevels } from '../graph.ts'
import { NodeId, type DagNodeDefinition, type DagWorkflowDefinition, type NodeTypeSummary, type WorkflowStudioSnapshot } from '../types.ts'
import { workflowDefinitionSchema, workflowStudioSnapshotSchema } from '../workflow-schema.ts'

/** One saved workflow in the editor snapshot. */
export type WorkflowRow = WorkflowStudioSnapshot['workflows'][number]

/** A scheduling dependency between two nodes, with the branch port when it gates the target. */
export interface ExecutionDependency {
  readonly source: DagNodeDefinition
  readonly target: DagNodeDefinition
  readonly conditionSourcePort?: string
}

export interface ExecutionPlanNode {
  readonly node: DagNodeDefinition
  readonly dependencies: readonly ExecutionDependency[]
}

export interface ExecutionStage {
  readonly index: number
  readonly nodes: readonly ExecutionPlanNode[]
}

export interface ExecutionPlan {
  readonly stages: readonly ExecutionStage[]
  readonly dependencies: readonly ExecutionDependency[]
  readonly cyclicNodeIds: readonly string[]
}

/**
 * Parse the `snapshot` Remote result.
 * @param source - JSON snapshot.
 * @returns The workflows and node catalog.
 */
export function parseSnapshot(source: string): WorkflowStudioSnapshot {
  return workflowStudioSnapshotSchema.parse(JSON.parse(source) as unknown)
}

/** Filter node types by user-visible metadata and source plugin. */
export function filterNodeTypes(
  nodeTypes: readonly NodeTypeSummary[],
  query: string,
): readonly NodeTypeSummary[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return nodeTypes
  return nodeTypes.filter(node => [
    node.label,
    node.type,
    node.description,
    node.sourcePlugin,
  ].some(value => value.toLocaleLowerCase().includes(needle)))
}

/** Filter workflow rows by name for the toolbar picker. */
export function filterWorkflows(
  workflows: readonly WorkflowRow[],
  query: string,
): readonly WorkflowRow[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return workflows
  return workflows.filter(workflow =>
    workflow.name.toLocaleLowerCase().includes(needle))
}

/** Return the first available workflow-N name. */
export function nextWorkflowName(workflows: readonly Pick<WorkflowRow, 'name'>[]): string {
  const names = new Set(workflows.map(workflow => workflow.name))
  let index = 1
  while (names.has(`workflow-${index}`)) index += 1
  return `workflow-${index}`
}

/**
 * Append one catalog node to an editor definition.
 * @param definition - Current editor definition.
 * @param nodeType - Catalog entry selected by the user.
 * @returns A new definition containing the positioned node.
 */
export function appendEditorNode(
  definition: DagWorkflowDefinition,
  nodeType: NodeTypeSummary,
): DagWorkflowDefinition {
  const id = NodeId(nextEditorNodeId(nodeType.type, definition.nodes))
  return {
    ...definition,
    nodes: [
      ...definition.nodes,
      {
        id,
        type: nodeType.type,
        config: Object.fromEntries(
          nodeType.controls.map(control => [control.name, control.defaultValue]),
        ),
        position: nextEditorNodePosition(definition.nodes),
        ...(nodeType.variadicInputs === undefined
          ? {}
          : {
            inputs: [...nodeType.inputs],
            outputs: [...nodeType.outputs],
          }),
      },
    ],
  }
}

/** Group nodes into the same topological stages used by the workflow scheduler. */
export function createExecutionPlan(definition: DagWorkflowDefinition): ExecutionPlan {
  const { levels, cyclic } = topologicalLevels(definition.nodes, definition.edges)
  const nodeById = new Map(definition.nodes.map(node => [node.id, node]))
  const incoming = new Map(definition.nodes.map(node => [node.id, [] as { -readonly [K in keyof ExecutionDependency]: ExecutionDependency[K] }[]]))
  const dependencies: ExecutionDependency[] = []
  for (const edge of definition.edges) {
    const conditionSourcePort = edge.targetPort === 'condition' ? edge.sourcePort : undefined
    const targetDependencies = incoming.get(edge.target)!
    const existing = targetDependencies.find(dependency => dependency.source.id === edge.source)
    if (existing !== undefined) {
      if (existing.conditionSourcePort === undefined && conditionSourcePort !== undefined) {
        existing.conditionSourcePort = conditionSourcePort
      }
      continue
    }
    const dependency = {
      source: nodeById.get(edge.source)!,
      target: nodeById.get(edge.target)!,
      ...(conditionSourcePort === undefined ? {} : { conditionSourcePort }),
    }
    targetDependencies.push(dependency)
    dependencies.push(dependency)
  }
  return {
    stages: levels.map((nodes, index) => ({
      index: index + 1,
      nodes: nodes.map(node => ({ node, dependencies: incoming.get(node.id)! })),
    })),
    dependencies,
    cyclicNodeIds: cyclic.map(node => node.id),
  }
}

function nextEditorNodeId(type: string, nodes: readonly DagNodeDefinition[]): string {
  const used = new Set<string>(nodes.map(node => node.id))
  let index = 1
  while (used.has(`${type}-${index}`)) index += 1
  return `${type}-${index}`
}

function nextEditorNodePosition(nodes: readonly DagNodeDefinition[]): { x: number; y: number } {
  const occupiedPositions = nodes.map((node, index) => node.position ?? {
    x: 80 + (index % 4) * 240,
    y: 80 + Math.floor(index / 4) * 180,
  })
  for (let row = 0; ; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const candidate = { x: 80 + column * 260, y: 80 + row * 190 }
      const occupied = occupiedPositions.some(position =>
        Math.abs(position.x - candidate.x) < 230
        && Math.abs(position.y - candidate.y) < 160)
      if (!occupied) return candidate
    }
  }
}

/**
 * Remove dependency edges already represented by another directed path.
 * @param plan - Scheduler-compatible execution plan.
 * @returns The graph's transitive reduction, or all dependencies for a cyclic graph.
 */
export function reduceExecutionDependencies(
  plan: ExecutionPlan,
): readonly ExecutionDependency[] {
  if (plan.cyclicNodeIds.length > 0) return plan.dependencies

  const outgoing = new Map<string, Set<string>>()
  for (const dependency of plan.dependencies) {
    const targets = outgoing.get(dependency.source.id) ?? new Set<string>()
    targets.add(dependency.target.id)
    outgoing.set(dependency.source.id, targets)
  }

  return plan.dependencies.filter(dependency =>
    !hasAlternatePath(
      dependency.source.id,
      dependency.target.id,
      outgoing,
    ),
  )
}

function hasAlternatePath(
  sourceId: string,
  targetId: string,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const visited = new Set([sourceId])
  const pending = [...(outgoing.get(sourceId) ?? [])]
    .filter(nodeId => nodeId !== targetId)

  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (nodeId === targetId) return true
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    pending.push(...(outgoing.get(nodeId) ?? []))
  }
  return false
}

/** Parse a workflow with the same schema used by Host persistence. */
export function parseEditorDefinition(source: string): DagWorkflowDefinition {
  return workflowDefinitionSchema.parse(JSON.parse(source) as unknown)
}

/** Encode one editor definition for the Host parser. */
export function formatEditorDefinition(definition: DagWorkflowDefinition): string {
  return JSON.stringify(definition, null, 2)
}
