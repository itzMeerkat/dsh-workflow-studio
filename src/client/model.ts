/** Browser-side workflow editing helpers used by the visual editor. */

import type { XYPosition } from '@xyflow/react'
import { execSourcePin, isExecEdge, topologicalLevels } from '../shared/graph.ts'
import { SUBWORKFLOW_FIELD, SUBWORKFLOW_TYPE, subworkflowPorts } from '../shared/subworkflow.ts'
import {
  EdgeId, NodeId, type DagEdgeDefinition, type DagNodeDefinition, type DagWorkflowDefinition, type NodeTypeSummary,
  type WorkflowId, type WorkflowStudioSnapshot,
} from '../shared/types.ts'
import { isBoundaryNode } from '../shared/workflow-boundary.ts'
import type { WorkflowRefusal } from '../shared/refusal.ts'

/** One saved workflow in the editor snapshot. */
export type WorkflowRow = WorkflowStudioSnapshot['workflows'][number]

/** A scheduling dependency between two nodes, with the execution pin when one gates the target. */
export interface ExecutionDependency {
  readonly source: DagNodeDefinition
  readonly target: DagNodeDefinition
  /** The source's execution pin, set only for an execution dependency, which reduction keeps. */
  readonly execSourcePin?: string
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

/** A saved workflow offered for embedding; `cycle` marks one that already embeds the edited workflow. */
export type EmbedChoice = WorkflowRow & { readonly fault?: 'cycle' }

/** Filter workflow rows by name for the toolbar picker. */
export function filterWorkflows<W extends Pick<WorkflowRow, 'name'>>(
  workflows: readonly W[],
  query: string,
): readonly W[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return workflows
  return workflows.filter(workflow =>
    workflow.name.toLocaleLowerCase().includes(needle))
}

/**
 * The first available `workflow-N` name for a new workflow.
 * @param workflows - Every saved workflow.
 */
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
 * @param at - Where the node's top-left corner goes, unless a node already sits there.
 * @returns A new definition containing the positioned node.
 */
export function appendEditorNode(
  definition: DagWorkflowDefinition,
  nodeType: NodeTypeSummary,
  at: XYPosition,
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
        position: freePosition(definition.nodes, at),
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

/**
 * Append a node that embeds another saved workflow, named after it.
 * @param definition - Current editor definition.
 * @param id - The embedded workflow's ID, which the node links to.
 * @param child - The embedded workflow.
 * @param at - Where the node's top-left corner goes, unless a node already sits there.
 * @returns A new definition containing the positioned node, its ports read from the embedded workflow's inputs and outputs.
 */
export function appendSubworkflowNode(
  definition: DagWorkflowDefinition,
  id: WorkflowId,
  child: DagWorkflowDefinition,
  at: XYPosition,
): DagWorkflowDefinition {
  const { inputs, outputs } = subworkflowPorts(child)
  return {
    ...definition,
    nodes: [
      ...definition.nodes,
      {
        id: NodeId(nextEditorNodeId(SUBWORKFLOW_TYPE, definition.nodes)),
        type: SUBWORKFLOW_TYPE,
        label: child.name,
        config: { [SUBWORKFLOW_FIELD]: id },
        position: freePosition(definition.nodes, at),
        inputs,
        outputs,
      },
    ],
  }
}

/** Nodes copied from the canvas, with the edges that join two of them. */
export interface Clip {
  readonly nodes: readonly DagNodeDefinition[]
  readonly edges: readonly DagEdgeDefinition[]
}

/**
 * Copy some nodes of a definition.
 *
 * Boundary nodes stay behind, because a workflow has at most one per side, and so does every edge with an end outside
 * the copy, because pasting cannot know what it would connect to.
 * @param definition - The edited definition.
 * @param ids - The selected node IDs.
 * @returns The copy, or undefined when nothing copyable is selected.
 */
export function copyNodes(definition: DagWorkflowDefinition, ids: ReadonlySet<string>): Clip | undefined {
  const nodes = definition.nodes.filter(node => ids.has(node.id) && !isBoundaryNode(node))
  if (nodes.length === 0) return undefined
  const copied = new Set<string>(nodes.map(node => node.id))
  return { nodes, edges: definition.edges.filter(edge => copied.has(edge.source) && copied.has(edge.target)) }
}

/**
 * Paste a copy into a definition: each node takes a fresh ID derived from its type and sits `offset` pixels down and to
 * the right of where it was copied, and each edge takes a fresh ID and the pasted nodes' IDs.
 * @param definition - The edited definition.
 * @param clip - The copy.
 * @param offset - How far the pasted nodes move from the copied ones, in pixels.
 * @returns The definition with the pasted nodes and edges, and the pasted node IDs.
 */
export function pasteNodes(
  definition: DagWorkflowDefinition,
  clip: Clip,
  offset: number,
): { definition: DagWorkflowDefinition; ids: string[] } {
  const nodes = [...definition.nodes]
  const renamed = new Map<string, NodeId>()
  for (const node of clip.nodes) {
    const id = NodeId(nextEditorNodeId(node.type, nodes))
    renamed.set(node.id, id)
    const position = node.position === undefined ? undefined : { x: node.position.x + offset, y: node.position.y + offset }
    nodes.push({ ...structuredClone(node), id, ...(position === undefined ? {} : { position }) })
  }
  const edges = clip.edges.map(edge =>
    ({ ...edge, id: EdgeId(crypto.randomUUID()), source: renamed.get(edge.source)!, target: renamed.get(edge.target)! }))
  return { definition: { ...definition, nodes, edges: [...definition.edges, ...edges] }, ids: [...renamed.values()] }
}

/** Group nodes into the same topological stages used by the workflow scheduler. */
export function createExecutionPlan(definition: DagWorkflowDefinition): ExecutionPlan {
  const { levels, cyclic } = topologicalLevels(definition.nodes, definition.edges)
  const nodeById = new Map(definition.nodes.map(node => [node.id, node]))
  const incoming = new Map(definition.nodes.map(node => [node.id, [] as { -readonly [K in keyof ExecutionDependency]: ExecutionDependency[K] }[]]))
  const dependencies: ExecutionDependency[] = []
  for (const edge of definition.edges) {
    const pin = isExecEdge(edge) ? execSourcePin(edge) : undefined
    const targetDependencies = incoming.get(edge.target)!
    const existing = targetDependencies.find(dependency => dependency.source.id === edge.source)
    if (existing !== undefined) {
      if (existing.execSourcePin === undefined && pin !== undefined) existing.execSourcePin = pin
      continue
    }
    const dependency = {
      source: nodeById.get(edge.source)!,
      target: nodeById.get(edge.target)!,
      ...(pin === undefined ? {} : { execSourcePin: pin }),
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

/**
 * `at`, moved down and to the right past every node already placed there, so a node added twice at the same spot
 * does not hide the first.
 */
function freePosition(nodes: readonly DagNodeDefinition[], at: XYPosition): XYPosition {
  const taken = (position: XYPosition): boolean => nodes.some(node => node.position !== undefined
    && Math.abs(node.position.x - position.x) < 16 && Math.abs(node.position.y - position.y) < 16)
  let position = at
  while (taken(position)) position = { x: position.x + 32, y: position.y + 32 }
  return position
}

/**
 * Remove dependency edges already represented by another directed path.
 *
 * An execution dependency is kept even when a data path already implies it, because the author drew it.
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
    dependency.execSourcePin !== undefined
    || !hasAlternatePath(
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

/**
 * Why the panel cannot edit a definition.
 *
 * Every view assumes each edge joins two nodes. Saving refuses a definition breaking that, but a record saved by an
 * older version or an imported file may break it, so the panel checks here instead of failing in whichever view reads it.
 * @param definition - The parsed definition.
 * @returns The first reason, as the refusal the Host gives for the same fault, or undefined when the panel can edit it.
 */
export function openFault(definition: DagWorkflowDefinition): WorkflowRefusal | undefined {
  const ids = new Set<string>(definition.nodes.map(node => node.id))
  for (const edge of definition.edges) {
    if (!ids.has(edge.source)) return { code: 'edge-node-missing', edge: edge.id, end: 'source', node: edge.source }
    if (!ids.has(edge.target)) return { code: 'edge-node-missing', edge: edge.id, end: 'target', node: edge.target }
  }
  return undefined
}

/** A saved workflow in the picker, with why the panel cannot open it. */
export type PickerRow = WorkflowRow & { readonly fault?: WorkflowRefusal }

/**
 * Whether a key event belongs to a text field, whose own undo, copy, and paste must keep working.
 * @param target - The event's target.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
}

/** Encode one editor definition as the JSON an exported file holds. */
export function formatEditorDefinition(definition: DagWorkflowDefinition): string {
  return JSON.stringify(definition, null, 2)
}
