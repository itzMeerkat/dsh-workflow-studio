/** Interactive DAG canvas backed by React Flow. */

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  reconnectEdge,
} from '@xyflow/react'
import type {
  Connection,
  Edge,
  EdgeChange,
  FinalConnectionState,
  Node,
  NodeChange,
  NodeProps,
} from '@xyflow/react'
import {
  Button,
  IconCloseOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  EditorControl,
  EditorEdge,
  EditorNode,
  EditorNodeRunRecord,
  EditorPort,
  EditorWorkflowDefinition,
  NodeTypeRow,
} from './model.ts'
import css from './WorkflowStudioPanel.module.css'

type GraphEditorKey =
  | 'action.apply'
  | 'action.delete'
  | 'inspector.title'
  | 'inspector.close'
  | 'inspector.empty'
  | 'inspector.label'
  | 'inspector.config'
  | 'result.title'
  | 'result.empty'
  | 'notice.connectPorts'
  | 'notice.configObject'
  | 'notice.incompatiblePorts'
  | 'notice.inputConnected'

type Translate = (key: GraphEditorKey) => string

type WorkflowNodeData = {
  definition: EditorNode
  catalog?: NodeTypeRow
  runRecord?: EditorNodeRunRecord
} & Record<string, unknown>

type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>

interface WorkflowGraphEditorProps {
  readonly definition: EditorWorkflowDefinition
  readonly revision: number
  readonly nodeTypes: readonly NodeTypeRow[]
  readonly runRecords: ReadonlyMap<string, EditorNodeRunRecord>
  readonly runResult?: string
  readonly t: Translate
  readonly onChange: (definition: EditorWorkflowDefinition) => void
  readonly onError: (message: string | undefined) => void
}

interface NodeCardContextValue {
  readonly updateConfig: (nodeId: string, name: string, value: unknown) => void
}

const NodeCardContext = createContext<NodeCardContextValue | undefined>(undefined)

/** Render and edit one workflow definition as a connected node graph. */
export function WorkflowGraphEditor({
  definition,
  revision,
  nodeTypes,
  runRecords,
  runResult,
  t,
  onChange,
  onError,
}: WorkflowGraphEditorProps) {
  const catalog = useMemo(
    () => new Map(nodeTypes.map(node => [node.type, node])),
    [nodeTypes],
  )
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
    setNodes(current => current.map(node => ({
      ...node,
      data: withRunRecord(node.data, runRecords.get(node.id)),
    })))
  }, [runRecords])

  const selectedNode = nodes.find(node => node.id === selectedNodeId)

  const applyNodes = (changes: NodeChange<WorkflowFlowNode>[]): void => {
    setNodes((current) => {
      const next = applyNodeChanges(changes, current)
      emitDefinition(definition, next, edges, onChange)
      return next
    })
  }

  const applyEdges = (changes: EdgeChange[]): void => {
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current)
      emitDefinition(definition, nodes, next, onChange)
      return next
    })
  }

  const connect = (connection: Connection): void => {
    if (connection.sourceHandle === null || connection.targetHandle === null) {
      onError(t('notice.connectPorts'))
      return
    }
    const error = connectionError(connection, nodes, edges)
    if (error !== undefined) {
      onError(t(error))
      return
    }
    setEdges((current) => {
      const next = addEdge({
        ...connection,
        id: crypto.randomUUID(),
        markerEnd: { type: MarkerType.ArrowClosed },
      }, current)
      emitDefinition(definition, nodes, next, onChange)
      return next
    })
    onError(undefined)
  }

  const reconnect = (oldEdge: Edge, connection: Connection): void => {
    const error = connectionError(connection, nodes, edges, oldEdge.id)
    if (error !== undefined) {
      onError(t(error))
      return
    }
    setEdges((current) => {
      const next = reconnectEdge(oldEdge, connection, current, { shouldReplaceId: false })
      emitDefinition(definition, nodes, next, onChange)
      return next
    })
    onError(undefined)
  }

  const finishReconnect = (
    edge: Edge,
    connectionState: FinalConnectionState,
  ): void => {
    reconnectingEdgeId.current = undefined
    if (connectionState.toHandle !== null) return
    setEdges((current) => {
      const next = current.filter(item => item.id !== edge.id)
      emitDefinition(definition, nodes, next, onChange)
      return next
    })
  }

  const updateNodeConfig = (nodeId: string, name: string, value: unknown): void => {
    setNodes((current) => {
      const next = current.map((node) => {
        if (node.id !== nodeId) return node
        const config = { ...node.data.definition.config, [name]: value }
        if (selectedNodeId === nodeId) setConfigSource(JSON.stringify(config, null, 2))
        return {
          ...node,
          data: {
            ...node.data,
            definition: { ...node.data.definition, config },
          },
        }
      })
      emitDefinition(definition, next, edges, onChange)
      return next
    })
  }

  const updateSelected = (patch: Partial<EditorNode>): void => {
    if (selectedNodeId === undefined) return
    setNodes((current) => {
      const next = current.map(node => node.id === selectedNodeId
        ? { ...node, data: { ...node.data, definition: { ...node.data.definition, ...patch } } }
        : node)
      emitDefinition(definition, next, edges, onChange)
      return next
    })
  }

  const applyConfig = (): void => {
    try {
      const value = JSON.parse(configSource) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(t('notice.configObject'))
      }
      updateSelected({ config: value as Record<string, unknown> })
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
    emitDefinition(definition, nextNodes, nextEdges, onChange)
  }

  return (
    <div className={css.graphLayout}>
      <div className={css.canvas}>
        <NodeCardContext.Provider value={{ updateConfig: updateNodeConfig }}>
          <ReactFlow<WorkflowFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={{ workflow: WorkflowNodeCard }}
            onNodesChange={applyNodes}
            onEdgesChange={applyEdges}
            onConnect={connect}
            isValidConnection={connection =>
              connectionError(connection, nodes, edges, reconnectingEdgeId.current) === undefined}
            onReconnectStart={(_event, edge) => {
              reconnectingEdgeId.current = edge.id
            }}
            onReconnect={reconnect}
            onReconnectEnd={(_event, edge, _handleType, connectionState) => {
              finishReconnect(edge, connectionState)
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
        <section className={css.detailsPanel}>
          <div className={css.detailsHeader}>
            <h2>{t('inspector.title')}</h2>
            <button
              type="button"
              className={css.detailsClose}
              aria-label={t('inspector.close')}
              title={t('inspector.close')}
              onClick={() => { setSelectedNodeId(undefined) }}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          <div className={css.detailsContent}>
            <section>
              <div className={css.inspectorForm}>
                <label>
                  <span>{t('inspector.label')}</span>
                  <input
                    value={selectedNode.data.definition.label ?? ''}
                    placeholder={selectedNode.data.catalog?.label ?? selectedNode.data.definition.type}
                    onChange={event => { updateSelected({ label: event.currentTarget.value }) }}
                  />
                </label>
                <label>
                  <span>{t('inspector.config')}</span>
                  <textarea
                    aria-label={t('inspector.config')}
                    spellCheck={false}
                    value={configSource}
                    onChange={event => { setConfigSource(event.currentTarget.value) }}
                  />
                </label>
                <div className={css.inspectorActions}>
                  <Button size="sm" variant="outline" onClick={applyConfig}>
                    {t('action.apply')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<IconTrashOutline16 size={14} />}
                    onClick={deleteSelected}
                  >
                    {t('action.delete')}
                  </Button>
                </div>
              </div>
            </section>
            <section className={css.resultPanel}>
              <h2>{t('result.title')}</h2>
              {runResult === undefined
                ? <p>{t('result.empty')}</p>
                : <pre>{runResult}</pre>}
            </section>
          </div>
        </section>
      )}
    </div>
  )
}

function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const inputs = resolvedInputPorts(data)
  const outputs = resolvedOutputPorts(data)
  const controls = data.catalog?.controls ?? []
  const runOutputs = data.runRecord?.outputs
  const { updateConfig } = useNodeCardContext()
  return (
    <div className={`${css.canvasNode} ${selected ? css.canvasNodeSelected : ''}`}>
      <div className={css.nodeHeader}>
        <strong>{data.definition.label ?? data.catalog?.label ?? data.definition.type}</strong>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
      </div>
      <code>{data.definition.type}</code>
      <div className={css.ports}>
        <div>{inputs.map(port => (
          <PortRow key={port.name} port={port} side="input" />
        ))}</div>
        <div>{outputs.map(port => (
          <PortRow key={port.name} port={port} side="output" />
        ))}</div>
      </div>
      {controls.length > 0 && (
        <div className={css.nodeControls}>
          {controls.map(control => (
            <NodeControl
              key={control.name}
              control={control}
              value={data.definition.config[control.name] ?? control.defaultValue}
              onChange={(value) => { updateConfig(data.definition.id, control.name, value) }}
            />
          ))}
        </div>
      )}
      {runOutputs !== undefined && (
        <div className={css.nodeOutputs}>
          {outputs
            .filter(port => port.display !== undefined
              && Object.hasOwn(runOutputs, port.name))
            .map(port => (
              <div key={port.name} className={css.nodeOutput}>
                <span>{port.name}</span>
                <output>{formatOutput(runOutputs[port.name], port.display ?? 'value')}</output>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function PortRow({
  port,
  side,
}: {
  readonly port: EditorPort
  readonly side: 'input' | 'output'
}) {
  const isInput = side === 'input'
  return (
    <div
      className={[
        css.port,
        isInput ? css.portInput : css.portOutput,
        port.role === 'condition' ? css.conditionPort : '',
      ].join(' ')}
      title={port.description}
    >
      <Handle
        type={isInput ? 'target' : 'source'}
        position={isInput ? Position.Left : Position.Right}
        id={port.name}
      />
      <span>
        {port.name}
        {isInput && port.required !== false && <b className={css.requiredPort}>*</b>}
      </span>
      <small>{port.type}</small>
    </div>
  )
}

function NodeControl({
  control,
  value,
  onChange,
}: {
  readonly control: EditorControl
  readonly value: unknown
  readonly onChange: (value: unknown) => void
}) {
  if (control.kind === 'boolean') {
    return (
      <label className={`${css.nodeControl} nodrag`}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={event => { onChange(event.currentTarget.checked) }}
        />
        <span>{control.label}</span>
      </label>
    )
  }
  if (control.kind === 'select') {
    return (
      <label className={`${css.nodeControl} nodrag`}>
        <span>{control.label}</span>
        <select
          className="nowheel"
          value={typeof value === 'string' ? value : control.defaultValue}
          onChange={event => { onChange(event.currentTarget.value) }}
        >
          {control.options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label className={`${css.nodeControl} nodrag`}>
      <span>{control.label}</span>
      <input
        className="nowheel"
        type={control.kind}
        value={controlValue(value, control)}
        {...(control.kind === 'number' && control.min !== undefined ? { min: control.min } : {})}
        {...(control.kind === 'number' && control.max !== undefined ? { max: control.max } : {})}
        {...(control.kind === 'number' && control.step !== undefined ? { step: control.step } : {})}
        {...(control.kind === 'text' && control.placeholder !== undefined
          ? { placeholder: control.placeholder }
          : {})}
        onChange={(event) => {
          if (control.kind === 'number') {
            const next = event.currentTarget.valueAsNumber
            if (Number.isFinite(next)) onChange(next)
          } else {
            onChange(event.currentTarget.value)
          }
        }}
      />
    </label>
  )
}

function flowNodes(
  definition: EditorWorkflowDefinition,
  catalog: ReadonlyMap<string, NodeTypeRow>,
  runRecords: ReadonlyMap<string, EditorNodeRunRecord>,
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

function flowEdges(definition: EditorWorkflowDefinition): Edge[] {
  return definition.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort ?? 'output',
    targetHandle: edge.targetPort ?? 'input',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
}

function emitDefinition(
  previous: EditorWorkflowDefinition,
  nodes: readonly WorkflowFlowNode[],
  edges: readonly Edge[],
  emit: (definition: EditorWorkflowDefinition) => void,
): void {
  emit({
    ...previous,
    nodes: nodes.map(node => ({
      ...node.data.definition,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: edges.map(edge => edgeDefinition(edge)),
  })
}

function edgeDefinition(edge: Edge): EditorEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === undefined || edge.sourceHandle === null
      ? {}
      : { sourcePort: edge.sourceHandle }),
    ...(edge.targetHandle === undefined || edge.targetHandle === null
      ? {}
      : { targetPort: edge.targetHandle }),
  }
}

function resolvedInputPorts(data: WorkflowNodeData): readonly EditorPort[] {
  const catalogInputs = data.catalog?.inputs ?? []
  const instanceInputs = data.definition.inputs
    ?? catalogInputs.filter(port => port.role !== 'condition')
  const condition = catalogInputs.find(port => port.role === 'condition')
  return condition === undefined ? instanceInputs : [...instanceInputs, condition]
}

function resolvedOutputPorts(data: WorkflowNodeData): readonly EditorPort[] {
  return data.definition.outputs ?? data.catalog?.outputs ?? []
}

function inputPorts(node: WorkflowFlowNode | undefined): readonly EditorPort[] {
  return node === undefined ? [] : resolvedInputPorts(node.data)
}

function outputPorts(node: WorkflowFlowNode | undefined): readonly EditorPort[] {
  return node === undefined ? [] : resolvedOutputPorts(node.data)
}

function portsAreCompatible(source: EditorPort, target: EditorPort): boolean {
  return source.type === 'any' || target.type === 'any' || source.type === target.type
}

function connectionError(
  connection: Connection | Edge,
  nodes: readonly WorkflowFlowNode[],
  edges: readonly Edge[],
  ignoredEdgeId?: string,
): Extract<
  GraphEditorKey,
  'notice.connectPorts' | 'notice.incompatiblePorts' | 'notice.inputConnected'
> | undefined {
  if (connection.sourceHandle === undefined || connection.sourceHandle === null
    || connection.targetHandle === undefined || connection.targetHandle === null) {
    return 'notice.connectPorts'
  }
  const sourceNode = nodes.find(node => node.id === connection.source)
  const targetNode = nodes.find(node => node.id === connection.target)
  const sourcePort = outputPorts(sourceNode).find(port => port.name === connection.sourceHandle)
  const targetPort = inputPorts(targetNode).find(port => port.name === connection.targetHandle)
  if (sourcePort === undefined || targetPort === undefined) return 'notice.connectPorts'
  if (!portsAreCompatible(sourcePort, targetPort)) return 'notice.incompatiblePorts'
  if (edges.some(edge =>
    edge.id !== ignoredEdgeId
    && edge.target === connection.target
    && edge.targetHandle === connection.targetHandle)) {
    return 'notice.inputConnected'
  }
  return undefined
}

function controlValue(value: unknown, control: Extract<EditorControl, { kind: 'number' | 'text' }>): string | number {
  if (control.kind === 'number') return typeof value === 'number' ? value : control.defaultValue
  return typeof value === 'string' ? value : control.defaultValue
}

function formatOutput(value: unknown, display: 'value' | 'json'): string {
  if (display === 'json') return JSON.stringify(value, null, 2) ?? 'undefined'
  return typeof value === 'string' ? value : String(value)
}

function useNodeCardContext(): NodeCardContextValue {
  const context = useContext(NodeCardContext)
  if (context === undefined) throw new Error('Workflow node card rendered outside its editor')
  return context
}

function withRunRecord(
  data: WorkflowNodeData,
  runRecord: EditorNodeRunRecord | undefined,
): WorkflowNodeData {
  const { runRecord: _previous, ...rest } = data
  return runRecord === undefined ? rest : { ...rest, runRecord }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
