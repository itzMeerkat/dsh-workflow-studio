/** Browser-side workflow DTOs used by the visual editor. */

import { workflowDefinitionSchema } from '../workflow-schema.ts'

export interface EditorPort {
  readonly name: string
  readonly type: 'number' | 'string' | 'boolean' | 'any'
  readonly description?: string
  readonly required?: boolean
  readonly role?: 'condition'
  readonly display?: 'value' | 'json'
}

export type EditorControl =
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'number'
    readonly defaultValue: number
    readonly min?: number
    readonly max?: number
    readonly step?: number
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'text'
    readonly defaultValue: string
    readonly placeholder?: string
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'boolean'
    readonly defaultValue: boolean
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'select'
    readonly defaultValue: string
    readonly options: readonly { readonly label: string; readonly value: string }[]
  }

export interface EditorNode {
  readonly id: string
  readonly type: string
  readonly label?: string
  readonly config: Record<string, unknown>
  readonly requiresHumanInput?: boolean
  readonly recovery?: 'rerun' | 'hold'
  readonly inputs?: readonly EditorPort[]
  readonly outputs?: readonly EditorPort[]
  readonly position?: { readonly x: number; readonly y: number }
}

export interface EditorEdge {
  readonly id: string
  readonly source: string
  readonly sourcePort?: string
  readonly target: string
  readonly targetPort?: string
}

export interface EditorWorkflowDefinition {
  readonly name: string
  readonly description?: string
  readonly nodes: readonly EditorNode[]
  readonly edges: readonly EditorEdge[]
}

export interface NodeTypeRow {
  readonly type: string
  readonly label: string
  readonly description: string
  readonly sourcePlugin: string
  readonly inputs: readonly EditorPort[]
  readonly outputs: readonly EditorPort[]
  readonly controls: readonly EditorControl[]
  readonly variadicInputs?: {
    readonly min: number
    readonly outputType?: 'same'
  }
}

export interface WorkflowRow {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly definition: string
}

export interface WorkflowStudioSnapshot {
  readonly workflows: readonly WorkflowRow[]
  readonly nodeTypes: readonly NodeTypeRow[]
}

export interface EditorNodeRunRecord {
  readonly nodeId: string
  readonly status: string
  readonly outputs?: Readonly<Record<string, unknown>>
}

export interface ExecutionDependency {
  readonly source: EditorNode
  readonly target: EditorNode
  readonly conditionSourcePort?: string
}

export interface ExecutionPlanNode {
  readonly node: EditorNode
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

/** Filter node types by user-visible metadata and source plugin. */
export function filterNodeTypes(
  nodeTypes: readonly NodeTypeRow[],
  query: string,
): readonly NodeTypeRow[] {
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
  definition: EditorWorkflowDefinition,
  nodeType: NodeTypeRow,
): EditorWorkflowDefinition {
  const id = nextEditorNodeId(nodeType.type, definition.nodes)
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
            inputs: nodeType.inputs,
            outputs: nodeType.outputs,
          }),
      },
    ],
  }
}

/** Group nodes into the same topological stages used by the workflow scheduler. */
export function createExecutionPlan(definition: EditorWorkflowDefinition): ExecutionPlan {
  type PendingDependency = {
    source: EditorNode
    target: EditorNode
    conditionSourcePort?: string
  }

  const nodeById = new Map(definition.nodes.map(node => [node.id, node]))
  const inDegree = new Map(definition.nodes.map(node => [node.id, 0]))
  const outgoing = new Map(definition.nodes.map(node => [node.id, new Set<string>()]))
  const incoming = new Map(definition.nodes.map(node => [node.id, [] as PendingDependency[]]))
  const dependencies: PendingDependency[] = []

  for (const edge of definition.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (source === undefined) {
      throw new Error(`Execution plan references unknown node ${edge.source}`)
    }
    if (target === undefined) {
      throw new Error(`Execution plan references unknown node ${edge.target}`)
    }
    const sourceTargets = outgoing.get(source.id)!
    const targetDependencies = incoming.get(target.id)!
    const conditionSourcePort = edge.targetPort === 'condition'
      ? edge.sourcePort
      : undefined
    const existing = targetDependencies.find(dependency => dependency.source.id === source.id)
    if (existing !== undefined) {
      if (existing.conditionSourcePort === undefined && conditionSourcePort !== undefined) {
        existing.conditionSourcePort = conditionSourcePort
      }
      continue
    }
    const dependency: PendingDependency = {
      source,
      target,
      ...(conditionSourcePort === undefined ? {} : { conditionSourcePort }),
    }
    sourceTargets.add(target.id)
    targetDependencies.push(dependency)
    dependencies.push(dependency)
    inDegree.set(edge.target, inDegree.get(edge.target)! + 1)
  }

  const stages: ExecutionStage[] = []
  let frontier = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)

  while (frontier.length > 0) {
    const nextFrontier: string[] = []
    stages.push({
      index: stages.length + 1,
      nodes: frontier.map((nodeId) => {
        return {
          node: nodeById.get(nodeId)!,
          dependencies: incoming.get(nodeId)!,
        }
      }),
    })

    for (const nodeId of frontier) {
      for (const targetId of outgoing.get(nodeId)!) {
        const nextDegree = inDegree.get(targetId)! - 1
        inDegree.set(targetId, nextDegree)
        if (nextDegree === 0) nextFrontier.push(targetId)
      }
    }
    frontier = nextFrontier
  }

  const scheduled = new Set(stages.flatMap(stage => stage.nodes.map(item => item.node.id)))
  return {
    stages,
    dependencies,
    cyclicNodeIds: definition.nodes
      .filter(node => !scheduled.has(node.id))
      .map(node => node.id),
  }
}

function nextEditorNodeId(type: string, nodes: readonly EditorNode[]): string {
  const used = new Set(nodes.map(node => node.id))
  let index = 1
  while (used.has(`${type}-${index}`)) index += 1
  return `${type}-${index}`
}

function nextEditorNodePosition(nodes: readonly EditorNode[]): { x: number; y: number } {
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
export function parseEditorDefinition(source: string): EditorWorkflowDefinition {
  return workflowDefinitionSchema.parse(JSON.parse(source) as unknown)
}

/** Encode one editor definition for the Host parser. */
export function formatEditorDefinition(definition: EditorWorkflowDefinition): string {
  return JSON.stringify(definition, null, 2)
}
