/** Conversion between workflow definitions and React Flow nodes and edges, and connection rules for the canvas. */

import type { WorkflowDiagnostic } from '../shared/analysis.ts'
import { MarkerType, type Connection, type Edge, type Node } from '@xyflow/react'
import {
  EXEC_RUN_PIN,
  EXEC_THEN_PIN,
  execOutputPins,
  execPinFault,
  execSourcePin,
  execTargetPin,
  isExecEdge,
  portsAreCompatible,
} from '../shared/graph.ts'
import { isBoundaryNode } from '../shared/workflow-boundary.ts'
import type { WorkflowPortEdit } from './workflow-ports.ts'
import {
  EdgeId,
  NodeId,
  type DagEdgeDefinition,
  type DagExecEdge,
  type DagNodeDefinition,
  type DagWorkflowDefinition,
  type NodeRunRecord,
  type NodeTypeSummary,
  type PortDefinition,
} from '../shared/types.ts'

/** Data of one canvas node: its definition, catalog entry, latest run record, and findings. */
export type WorkflowNodeData = {
  definition: DagNodeDefinition
  catalog?: NodeTypeSummary
  runRecord?: NodeRunRecord
  diagnostics?: readonly WorkflowDiagnostic[]
} & Record<string, unknown>

/**
 * A canvas node.
 *
 * A boundary node is drawn by its own card, so it carries a different React Flow node type and
 * the same data as every other node.
 */
export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow' | 'boundary'>

/** Locale key of a rejected connection. */
export type ConnectionError =
  | 'notice.connectPorts'
  | 'notice.incompatiblePorts'
  | 'notice.inputConnected'
  | 'notice.mixedEdgeKinds'
  | 'notice.duplicateExecEdge'

/** What one canvas handle stands for: a data port or an execution pin. */
export type HandleRef =
  | { readonly kind: 'data'; readonly name: string }
  | { readonly kind: 'exec'; readonly name: string }

const HANDLE_PREFIX = { data: 'data:', exec: 'exec:' } as const

/**
 * The React Flow handle id for one port or pin.
 *
 * Both kinds are prefixed, so the id says which graph the handle belongs to and a data port may
 * carry any name — including one that looks like a pin — without being mistaken for one.
 * @param ref - The port or pin the handle stands for.
 */
export function handleId(ref: HandleRef): string {
  return `${HANDLE_PREFIX[ref.kind]}${ref.name}`
}

/**
 * The port or pin a handle id names.
 * @param handle - React Flow handle id, or null when the canvas reports none.
 * @returns The port or pin, or undefined when the id is not one this editor wrote.
 */
export function parseHandle(handle: string | null | undefined): HandleRef | undefined {
  if (handle == null) return undefined
  if (handle.startsWith(HANDLE_PREFIX.exec)) return { kind: 'exec', name: handle.slice(HANDLE_PREFIX.exec.length) }
  if (handle.startsWith(HANDLE_PREFIX.data)) return { kind: 'data', name: handle.slice(HANDLE_PREFIX.data.length) }
  return undefined
}

/**
 * Canvas nodes for a definition; nodes without a saved position are laid out in rows of four.
 * @param catalog - Registered node types by type.
 * @param runRecords - Latest run records by node ID.
 * @param diagnostics - Static-analysis findings by node ID.
 */
export function flowNodes(
  definition: DagWorkflowDefinition,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
  runRecords: ReadonlyMap<string, NodeRunRecord>,
  diagnostics: ReadonlyMap<string, readonly WorkflowDiagnostic[]>,
): WorkflowFlowNode[] {
  return definition.nodes.map((node, index) => {
    const nodeType = catalog.get(node.type)
    const runRecord = runRecords.get(node.id)
    const found = diagnostics.get(node.id)
    return {
      id: node.id,
      type: isBoundaryNode(node) ? 'boundary' : 'workflow',
      position: node.position ?? {
        x: 80 + (index % 4) * 240,
        y: 80 + Math.floor(index / 4) * 180,
      },
      data: {
        definition: node,
        ...(nodeType === undefined ? {} : { catalog: nodeType }),
        ...(runRecord === undefined ? {} : { runRecord }),
        ...(found === undefined ? {} : { diagnostics: found }),
      },
    }
  })
}

/** Canvas edges for a definition; omitted ports use the default `output` and `input` names. */
export function flowEdges(definition: DagWorkflowDefinition): Edge[] {
  return definition.edges.map(edge => isExecEdge(edge)
    ? {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: handleId({ kind: 'exec', name: execSourcePin(edge) }),
      targetHandle: handleId({ kind: 'exec', name: execTargetPin(edge) }),
      markerEnd: { type: MarkerType.ArrowClosed },
      className: 'workflow-exec-edge',
    }
    : {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: handleId({ kind: 'data', name: edge.sourcePort ?? 'output' }),
      targetHandle: handleId({ kind: 'data', name: edge.targetPort ?? 'input' }),
      markerEnd: { type: MarkerType.ArrowClosed },
    })
}

/**
 * The definition the canvas currently shows.
 * @param previous - Supplies the fields the canvas does not edit.
 */
export function toDefinition(
  previous: DagWorkflowDefinition,
  nodes: readonly WorkflowFlowNode[],
  edges: readonly Edge[],
): DagWorkflowDefinition {
  return {
    ...previous,
    nodes: nodes.map(node => ({
      ...node.data.definition,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: edges.map(edgeDefinition),
  }
}

function edgeDefinition(edge: Edge): DagEdgeDefinition {
  const identity = { id: EdgeId(edge.id), source: NodeId(edge.source), target: NodeId(edge.target) }
  const source = parseHandle(edge.sourceHandle)
  const target = parseHandle(edge.targetHandle)
  if (source?.kind === 'exec' || target?.kind === 'exec') {
    return {
      ...identity,
      kind: 'exec',
      sourcePort: source?.kind === 'exec' ? source.name : EXEC_THEN_PIN,
      targetPort: target?.kind === 'exec' ? target.name : EXEC_RUN_PIN,
    } satisfies DagExecEdge
  }
  return {
    ...identity,
    kind: 'data',
    ...(source === undefined ? {} : { sourcePort: source.name }),
    ...(target === undefined ? {} : { targetPort: target.name }),
  }
}

/** Input ports of a canvas node: its own ports or the catalog's. */
export function nodeInputPorts(data: WorkflowNodeData): readonly PortDefinition[] {
  return data.definition.inputs ?? data.catalog?.inputs ?? []
}

/** Output ports of a canvas node: its own ports or the catalog's. */
export function nodeOutputPorts(data: WorkflowNodeData): readonly PortDefinition[] {
  return data.definition.outputs ?? data.catalog?.outputs ?? []
}

/**
 * Why a connection may not be added.
 * @param ignoredEdgeId - An edge being reconnected, which does not occupy its target port.
 * @returns The notice key, or undefined when the connection is allowed.
 */
export function connectionError(
  connection: Connection | Edge,
  nodes: readonly WorkflowFlowNode[],
  edges: readonly Edge[],
  ignoredEdgeId?: string,
): ConnectionError | undefined {
  const source = parseHandle(connection.sourceHandle)
  const target = parseHandle(connection.targetHandle)
  if (source === undefined || target === undefined) return 'notice.connectPorts'
  if (source.kind !== target.kind) return 'notice.mixedEdgeKinds'
  const sourceNode = nodes.find(node => node.id === connection.source)
  const targetNode = nodes.find(node => node.id === connection.target)
  if (source.kind === 'exec' && target.kind === 'exec') {
    const declared = sourceNode === undefined ? [] : execOutputPins(sourceNode.data.catalog ?? {})
    if (execPinFault(declared, source.name, target.name) !== undefined) return 'notice.connectPorts'
    // An execution input joins every edge that reaches it, so only an identical edge is rejected.
    const duplicate = edges.some(edge =>
      edge.id !== ignoredEdgeId
      && edge.source === connection.source
      && edge.target === connection.target
      && edge.sourceHandle === connection.sourceHandle
      && edge.targetHandle === connection.targetHandle)
    return duplicate ? 'notice.duplicateExecEdge' : undefined
  }
  const sourcePort = sourceNode === undefined
    ? undefined
    : nodeOutputPorts(sourceNode.data).find(port => port.name === source.name)
  const targetPort = targetNode === undefined
    ? undefined
    : nodeInputPorts(targetNode.data).find(port => port.name === target.name)
  if (sourcePort === undefined || targetPort === undefined) return 'notice.connectPorts'
  if (!portsAreCompatible(sourcePort, targetPort)) return 'notice.incompatiblePorts'
  const occupied = edges.some(edge =>
    edge.id !== ignoredEdgeId
    && edge.target === connection.target
    && edge.targetHandle === connection.targetHandle)
  return occupied ? 'notice.inputConnected' : undefined
}

/**
 * Card data with its run record replaced; undefined removes it.
 * @param data - The card's current data.
 * @param runRecord - The node's latest run record, or undefined when the run has none.
 * @returns New data of the same kind of card.
 */
export function withRunRecord<T extends WorkflowNodeData>(data: T, runRecord: NodeRunRecord | undefined): T {
  const { runRecord: _previous, ...rest } = data
  // Rest destructuring widens a generic, so the result is named as the same card data again.
  return (runRecord === undefined ? rest : { ...rest, runRecord }) as T
}

/**
 * Canvas edges after one declared port of a boundary node was renamed or removed.
 *
 * An edge names the port it connects, so a renamed port takes its edges along and a removed
 * port takes them away; leaving them would name a port that no longer exists and fail the save.
 * @param edges - The canvas edges.
 * @param nodeId - The boundary node whose ports were edited.
 * @param edit - What the edit did.
 * @returns The edges, moved or dropped where they named the edited port.
 */
export function applyWorkflowPortEdit(
  edges: readonly Edge[],
  nodeId: string,
  edit: WorkflowPortEdit,
): Edge[] {
  if (edit.kind === 'other') return [...edges]
  const name = edit.kind === 'renamed' ? edit.from : edit.name
  return edges.flatMap((edge) => {
    const end = edge.source === nodeId ? 'source' : edge.target === nodeId ? 'target' : undefined
    if (end === undefined) return [edge]
    const handle = parseHandle(end === 'source' ? edge.sourceHandle : edge.targetHandle)
    if (handle?.kind !== 'data' || handle.name !== name) return [edge]
    if (edit.kind === 'removed') return []
    const moved = handleId({ kind: 'data', name: edit.to })
    return [end === 'source' ? { ...edge, sourceHandle: moved } : { ...edge, targetHandle: moved }]
  })
}
