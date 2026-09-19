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
import type { Connection, Edge, EdgeChange, NodeChange } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import type { DagNodeDefinition, DagWorkflowDefinition, NodeRunRecord, NodeTypeSummary } from '../shared/types.ts'
import {
  connectionError,
  flowEdges,
  flowNodes,
  toDefinition,
  withRunRecord,
  type WorkflowFlowNode,
} from './graph-model.ts'
import type { Translate } from './locale.ts'
import { NodeCardContext, WorkflowNodeCard } from './NodeCard.tsx'
import { NodeInspector } from './NodeInspector.tsx'
import css from './WorkflowStudioPanel.module.css'

const nodeTypes = { workflow: WorkflowNodeCard }

interface WorkflowGraphEditorProps {
  readonly definition: DagWorkflowDefinition
  /** Changing it discards the canvas graph and reloads `definition`. */
  readonly revision: number
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly runRecords: ReadonlyMap<string, NodeRunRecord>
  readonly runResult?: string
  readonly t: Translate
  readonly onChange: (definition: DagWorkflowDefinition) => void
  readonly onError: (message: string | undefined) => void
}

/** Render and edit one workflow definition as a connected node graph. */
export function WorkflowGraphEditor({
  definition,
  revision,
  nodeTypes: catalogTypes,
  runRecords,
  runResult,
  t,
  onChange,
  onError,
}: WorkflowGraphEditorProps) {
  const catalog = useMemo(() => new Map(catalogTypes.map(node => [node.type, node])), [catalogTypes])
  const [nodes, setNodes] = useState<WorkflowFlowNode[]>(() => flowNodes(definition, catalog, runRecords))
  const [edges, setEdges] = useState<Edge[]>(() => flowEdges(definition))
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [configSource, setConfigSource] = useState('{}')
  const reconnectingEdgeId = useRef<string>()

  useEffect(() => {
    setNodes(flowNodes(definition, catalog, runRecords))
    setEdges(flowEdges(definition))
    setSelectedNodeId(undefined)
  }, [revision, catalog])

  useEffect(() => {
    setNodes(current => current.map(node => ({ ...node, data: withRunRecord(node.data, runRecords.get(node.id)) })))
  }, [runRecords])

  const selectedNode = nodes.find(node => node.id === selectedNodeId)

  const commitNodes = (update: (current: WorkflowFlowNode[]) => WorkflowFlowNode[]): void => {
    setNodes((current) => {
      const next = update(current)
      onChange(toDefinition(definition, next, edges))
      return next
    })
  }

  const commitEdges = (update: (current: Edge[]) => Edge[]): void => {
    setEdges((current) => {
      const next = update(current)
      onChange(toDefinition(definition, nodes, next))
      return next
    })
  }

  const updateNode = (nodeId: string, update: (node: DagNodeDefinition) => DagNodeDefinition): void => {
    commitNodes(current => current.map(node => node.id === nodeId
      ? { ...node, data: { ...node.data, definition: update(node.data.definition) } }
      : node))
  }

  const updateConfig = (nodeId: string, name: string, value: unknown): void => {
    updateNode(nodeId, (node) => {
      const config = { ...node.config, [name]: value }
      if (nodeId === selectedNodeId) setConfigSource(JSON.stringify(config, null, 2))
      return { ...node, config }
    })
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
    const nextNodes = nodes.filter(node => node.id !== selectedNodeId)
    const nextEdges = edges.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId)
    setNodes(nextNodes)
    setEdges(nextEdges)
    setSelectedNodeId(undefined)
    onChange(toDefinition(definition, nextNodes, nextEdges))
  }

  return (
    <div className={css.graphLayout}>
      <div className={css.canvas}>
        <NodeCardContext.Provider value={{ updateConfig }}>
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
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.25}
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
