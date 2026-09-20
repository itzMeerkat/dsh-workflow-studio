/** Conversion between workflow definitions and React Flow nodes and edges, and connection rules for the canvas. */

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
  resolveInputPorts,
} from '../shared/graph.ts'
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

/** Data of one canvas node: its definition, catalog entry, and latest run record. */
export type WorkflowNodeData = {
  definition: DagNodeDefinition
  catalog?: NodeTypeSummary
  runRecord?: NodeRunRecord
} & Record<string, unknown>

/** A canvas node. */
export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>

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
 */
export function flowNodes(
  definition: DagWorkflowDefinition,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
  runRecords: ReadonlyMap<string, NodeRunRecord>,
): WorkflowFlowNode[] {
  return definition.nodes.map((node, index) => {
    const nodeType = catalog.get(node.type)
    const runRecord = runRecords.get(node.id)
    return {
      id: node.id,
      type: 'workflow',
      position: node.position ?? {
        x: 80 + (index % 4) * 240,
        y: 80 + Math.floor(index / 4) * 180,
      },
      data: {
        definition: node,
        ...(nodeType === undefined ? {} : { catalog: nodeType }),
        ...(runRecord === undefined ? {} : { runRecord }),
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

/** Input ports of a canvas node: its own ports or the catalog's, plus role ports. */
export function nodeInputPorts(data: WorkflowNodeData): readonly PortDefinition[] {
  return resolveInputPorts(data.definition.inputs, data.catalog?.inputs ?? [])
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

/** Node data with its run record replaced; undefined removes it. */
export function withRunRecord(data: WorkflowNodeData, runRecord: NodeRunRecord | undefined): WorkflowNodeData {
  const { runRecord: _previous, ...rest } = data
  return runRecord === undefined ? rest : { ...rest, runRecord }
}
