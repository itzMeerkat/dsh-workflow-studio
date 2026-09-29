/** Interactive DAG canvas backed by React Flow. */

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
} from '@xyflow/react'
import type { Connection, Edge, EdgeChange, NodeChange, ReactFlowInstance, XYPosition } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { messageOf } from '../shared/errors.ts'
import type { WorkflowDiagnostic } from '../shared/analysis.ts'
import type {
  DagNodeDefinition, DagWorkflowDefinition, NodeRunRecord, NodeTypeSummary, WorkflowId,
} from '../shared/types.ts'
import { withCallees, type Callees } from '../shared/callees.ts'
import { languageOf } from '../shared/language.ts'
import { SUBWORKFLOW_FIELD, subworkflowOf } from '../shared/subworkflow.ts'
import { SWITCH_CASES } from '../shared/switch.ts'
import {
  connectionError,
  flowEdges,
  flowNodes,
  handleId,
  nodeOutputPins,
  parseHandle,
  toDefinition,
  withRunRecord,
  type WorkflowFlowNode,
} from './graph-model.ts'
import type { Translate } from './locale.ts'
import type { WorkflowRow } from './model.ts'
import { NodeCardContext, WorkflowNodeCard } from './NodeCard.tsx'
import { NodeInspector } from './NodeInspector.tsx'
import { WorkflowBoundaryCard } from './WorkflowBoundaryCard.tsx'
import css from './WorkflowStudioPanel.module.css'

const nodeTypes = { workflow: WorkflowNodeCard, boundary: WorkflowBoundaryCard }

/** The canvas's nodes and edges, replaced together. */
interface CanvasGraph {
  readonly nodes: WorkflowFlowNode[]
  readonly edges: Edge[]
}

interface WorkflowGraphEditorProps {
  readonly definition: DagWorkflowDefinition
  /** Changing it discards the canvas graph and reloads `definition`. */
  readonly revision: number
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly runRecords: ReadonlyMap<string, NodeRunRecord>
  /** Static-analysis findings by node ID. */
  readonly diagnostics: ReadonlyMap<string, readonly WorkflowDiagnostic[]>
  readonly runResult?: string
  /** The atoms and workflows the graph's nodes call, which give those nodes their ports. */
  readonly callees: Callees
  /** The saved workflows a subworkflow node may link to. */
  readonly workflows: readonly WorkflowRow[]
  readonly t: Translate
  readonly onChange: (definition: DagWorkflowDefinition) => void
  readonly onError: (message: string | undefined) => void
  /** Set, while the canvas is shown, to where in the graph the middle of its view is. */
  readonly viewCenter: MutableRefObject<(() => XYPosition) | undefined>
}

/** Render and edit one workflow definition as a connected node graph. */
export function WorkflowGraphEditor({
  definition,
  revision,
  nodeTypes: catalogTypes,
  runRecords,
  diagnostics,
  runResult,
  callees,
  workflows,
  t,
  onChange,
  onError,
  viewCenter,
}: WorkflowGraphEditorProps) {
  const catalog = useMemo(() => new Map(catalogTypes.map(node => [node.type, node])), [catalogTypes])
  const [graph, setGraph] = useState<CanvasGraph>(() => ({
    nodes: flowNodes(definition, catalog, runRecords, diagnostics),
    edges: flowEdges(definition),
  }))
  // React Flow reports one deletion as a node change and an edge change in the same event, so each edit builds on
  // the graph the previous edit left, which state updated later in the event does not hold yet.
  const latest = useRef(graph)
  const { nodes, edges } = graph
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [configSource, setConfigSource] = useState('{}')
  const reconnectingEdgeId = useRef<string>()
  const canvas = useRef<HTMLDivElement>(null)
  const flow = useRef<ReactFlowInstance<WorkflowFlowNode, Edge>>()

  useEffect(() => {
    viewCenter.current = () => {
      const bounds = canvas.current!.getBoundingClientRect()
      return flow.current!.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
    }
    return () => { viewCenter.current = undefined }
  }, [])

  const show = (next: CanvasGraph): void => {
    latest.current = next
    setGraph(next)
  }

  /** Show an edited graph and report its definition; an edge goes with the node at either end. */
  const commit = (nextNodes: WorkflowFlowNode[], nextEdges: Edge[]): void => {
    const ids = new Set(nextNodes.map(node => node.id))
    const kept = nextEdges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
    show({ nodes: nextNodes, edges: kept })
    onChange(toDefinition(definition, nextNodes, kept))
  }

  useEffect(() => {
    show({ nodes: flowNodes(definition, catalog, runRecords, diagnostics), edges: flowEdges(definition) })
    setSelectedNodeId(undefined)
  }, [revision, catalog])

  useEffect(() => {
    show({
      ...latest.current,
      nodes: latest.current.nodes.map(node => ({ ...node, data: withRunRecord(node.data, runRecords.get(node.id)) })),
    })
  }, [runRecords])

  const selectedNode = nodes.find(node => node.id === selectedNodeId)

  const commitNodes = (update: (current: WorkflowFlowNode[]) => WorkflowFlowNode[]): void => {
    commit(update(latest.current.nodes), latest.current.edges)
  }

  const commitEdges = (update: (current: Edge[]) => Edge[]): void => {
    commit(latest.current.nodes, update(latest.current.edges))
  }

  /**
   * Replace one node's definition. A node calling an atom or a workflow takes its ports from it, and a switch
   * takes its pins from its cases, so the edit rereads both and drops the edges on ports and pins that are gone.
   * @param renamed - A pin whose name changed, so the edges on it follow.
   */
  const updateNode = (
    nodeId: string,
    update: (node: DagNodeDefinition) => DagNodeDefinition,
    renamed?: { readonly from: string; readonly to: string },
  ): void => {
    const { nodes, edges } = latest.current
    const edited = nodes.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, definition: update(node.data.definition) } }
      : node)
    const next = withCallees(toDefinition(definition, edited, edges), callees)
    const signed = next.nodes.find(node => node.id === nodeId)!
    const kept = new Set<string>(next.edges.map(edge => edge.id))
    const nextNodes = edited.map(node => node.id === nodeId ? { ...node, data: { ...node.data, definition: signed } } : node)
    const pins = nodeOutputPins(nextNodes.find(node => node.id === nodeId)!.data)
    const nextEdges = edges.flatMap((edge) => {
      if (!kept.has(edge.id)) return []
      const handle = edge.source === nodeId ? parseHandle(edge.sourceHandle) : undefined
      if (handle?.kind !== 'exec') return [edge]
      const pin = handle.name === renamed?.from ? renamed.to : handle.name
      return pins.includes(pin) ? [{ ...edge, sourceHandle: handleId({ kind: 'exec', name: pin }) }] : []
    })
    commit(nextNodes, nextEdges)
  }

  const updateConfig = (nodeId: string, name: string, value: unknown): void => {
    updateNode(nodeId, (node) => {
      const config = { ...node.config, [name]: value }
      if (nodeId === selectedNodeId) setConfigSource(JSON.stringify(config, null, 2))
      return { ...node, config }
    })
  }

  /** Link a subworkflow node to another workflow; its ports follow, and edges on ports that workflow lacks go. */
  const linkWorkflow = (nodeId: string, workflow: WorkflowId): void => {
    updateNode(nodeId, (node) => {
      // A label that only repeated the old workflow's name follows the new one.
      const named = node.label === undefined || node.label === callees.workflows.get(subworkflowOf(node.config))?.name
      const config = { ...node.config, [SUBWORKFLOW_FIELD]: workflow }
      if (nodeId === selectedNodeId) setConfigSource(JSON.stringify(config, null, 2))
      return { ...node, ...(named ? { label: callees.workflows.get(workflow)!.name } : {}), config }
    })
  }

  const editCases = (nodeId: string, cases: readonly string[], renamed?: { readonly from: string; readonly to: string }): void => {
    updateNode(nodeId, (node) => {
      const config = { ...node.config, [SWITCH_CASES]: cases }
      if (nodeId === selectedNodeId) setConfigSource(JSON.stringify(config, null, 2))
      return { ...node, config }
    }, renamed)
  }

  /** Show why a connection is rejected, or clear the notice when it is allowed. */
  const acceptConnection = (connection: Connection, ignoredEdgeId?: string): boolean => {
    const error = connectionError(connection, nodes, edges, ignoredEdgeId)
    onError(error === undefined ? undefined : t(error))
    return error === undefined
  }

  const applyConfig = (): void => {
    if (selectedNodeId === undefined) return
    try {
      const value = JSON.parse(configSource) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(t('notice.configObject'))
      }
      updateNode(selectedNodeId, node => ({ ...node, config: value as Record<string, unknown> }))
      onError(undefined)
    } catch (error: unknown) {
      onError(messageOf(error))
    }
  }

  const deleteSelected = (): void => {
    if (selectedNodeId === undefined) return
    commitNodes(current => current.filter(node => node.id !== selectedNodeId))
    setSelectedNodeId(undefined)
  }

  return (
    <div className={css.graphLayout}>
      <div ref={canvas} className={css.canvas}>
        <NodeCardContext.Provider value={{ t, language: languageOf(definition), updateConfig, linkWorkflow: { choices: workflows, link: linkWorkflow }, editCases }}>
          <ReactFlow<WorkflowFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes: NodeChange<WorkflowFlowNode>[]) => {
              commitNodes(current => applyNodeChanges(changes, current))
            }}
            onEdgesChange={(changes: EdgeChange[]) => {
              commitEdges(current => applyEdgeChanges(changes, current))
            }}
            onConnect={(connection) => {
              if (!acceptConnection(connection)) return
              commitEdges(current => addEdge({
                ...connection,
                id: crypto.randomUUID(),
                markerEnd: { type: MarkerType.ArrowClosed },
              }, current))
            }}
            isValidConnection={connection =>
              connectionError(connection, nodes, edges, reconnectingEdgeId.current) === undefined}
            onReconnectStart={(_event, edge) => {
              reconnectingEdgeId.current = edge.id
            }}
            onReconnect={(oldEdge, connection) => {
              if (!acceptConnection(connection, oldEdge.id)) return
              commitEdges(current => reconnectEdge(oldEdge, connection, current, { shouldReplaceId: false }))
            }}
            onReconnectEnd={(_event, edge, _handleType, connectionState) => {
              reconnectingEdgeId.current = undefined
              // Dropping a reconnected edge away from any port deletes it.
              if (connectionState.toHandle === null) commitEdges(current => current.filter(item => item.id !== edge.id))
            }}
            onNodeClick={(_event, node) => {
              setSelectedNodeId(node.id)
              setConfigSource(JSON.stringify(node.data.definition.config, null, 2))
            }}
            onPaneClick={() => { setSelectedNodeId(undefined) }}
            onInit={(instance) => { flow.current = instance }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.4}
            maxZoom={2}
            connectionRadius={24}
            reconnectRadius={18}
            edgesReconnectable
            connectionLineStyle={{
              stroke: 'var(--dsw-alias-brand-primary)',
              strokeWidth: 2,
            }}
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </NodeCardContext.Provider>
      </div>

      {selectedNode !== undefined && (
        <NodeInspector
          node={selectedNode}
          configSource={configSource}
          runResult={runResult}
          t={t}
          onLabel={(label) => { updateNode(selectedNode.id, node => ({ ...node, label })) }}
          onConfigSource={setConfigSource}
          onApplyConfig={applyConfig}
          onDelete={deleteSelected}
          onClose={() => { setSelectedNodeId(undefined) }}
        />
      )}
    </div>
  )
}
