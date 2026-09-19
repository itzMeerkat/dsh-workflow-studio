/** Conversion between workflow definitions and React Flow nodes and edges, and connection rules for the canvas. */

import { MarkerType, type Connection, type Edge, type Node } from '@xyflow/react'
import { portsAreCompatible, resolveInputPorts } from '../shared/graph.ts'
import {
  EdgeId,
  NodeId,
  type DagEdgeDefinition,
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
export type ConnectionError = 'notice.connectPorts' | 'notice.incompatiblePorts' | 'notice.inputConnected'

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
  return definition.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort ?? 'output',
    targetHandle: edge.targetPort ?? 'input',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
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
  return {
    id: EdgeId(edge.id),
    source: NodeId(edge.source),
    target: NodeId(edge.target),
    ...(edge.sourceHandle == null ? {} : { sourcePort: edge.sourceHandle }),
    ...(edge.targetHandle == null ? {} : { targetPort: edge.targetHandle }),
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
  if (connection.sourceHandle == null || connection.targetHandle == null) return 'notice.connectPorts'
  const sourceNode = nodes.find(node => node.id === connection.source)
  const targetNode = nodes.find(node => node.id === connection.target)
  const sourcePort = sourceNode === undefined
    ? undefined
    : nodeOutputPorts(sourceNode.data).find(port => port.name === connection.sourceHandle)
  const targetPort = targetNode === undefined
    ? undefined
    : nodeInputPorts(targetNode.data).find(port => port.name === connection.targetHandle)
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
