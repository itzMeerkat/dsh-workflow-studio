/** Read-only graph of the scheduler's node execution dependencies. */

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
} from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { useMemo } from 'react'
import type { DagNodeDefinition, DagWorkflowDefinition, NodeRunRecord, NodeTypeSummary } from '../shared/types.ts'
import type { ExecutionDependency, ExecutionPlan } from './model.ts'
import {
  createExecutionPlan,
  reduceExecutionDependencies,
} from './model.ts'
import type { Translate } from './locale.ts'
import css from './WorkflowStudioPanel.module.css'

type ExecutionNodeData = {
  definition: DagNodeDefinition
  catalog?: NodeTypeSummary
  runRecord?: NodeRunRecord
  stage: number
  stageLabel: string
  branchPorts: readonly string[]
} & Record<string, unknown>

type ExecutionFlowNode = Node<ExecutionNodeData, 'execution'>
const executionNodeTypes = { execution: ExecutionNodeCard }

interface ExecutionOrderViewProps {
  readonly definition: DagWorkflowDefinition
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly runRecords: ReadonlyMap<string, NodeRunRecord>
  readonly t: Translate
}

/** Render execution stages without exposing graph editing controls. */
export function ExecutionOrderView({
  definition,
  nodeTypes,
  runRecords,
  t,
}: ExecutionOrderViewProps) {
  const plan = useMemo(() => createExecutionPlan(definition), [definition])
  const catalog = useMemo(
    () => new Map(nodeTypes.map(node => [node.type, node])),
    [nodeTypes],
  )
  const dependencies = useMemo(
    () => reduceExecutionDependencies(plan),
    [plan],
  )
  const branchPorts = useMemo(() => branchPinsBySource(dependencies, catalog), [catalog, dependencies])
  const nodes = useMemo(
    () => executionNodes(plan, branchPorts, catalog, runRecords, t('execution.stage')),
    [branchPorts, catalog, plan, runRecords, t],
  )
  const edges = useMemo(() => executionEdges(dependencies, branchPorts), [branchPorts, dependencies])

  return (
    <section className={css.executionView} aria-label={t('execution.title')}>
      <header className={css.executionSummary}>
        <h2>{t('execution.title')}</h2>
        <span>
          {plan.stages.length} {t('execution.stages')}
          <b aria-hidden="true">·</b>
          {definition.nodes.length} {t('execution.nodes')}
        </span>
      </header>

      <div className={`${css.canvas} ${css.executionCanvas}`}>
        <ReactFlow<ExecutionFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={executionNodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.24 }}
          minZoom={0.35}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {plan.cyclicNodeIds.length > 0 && (
        <p className={css.executionCycle} role="alert">
          {t('execution.cycle')}: {plan.cyclicNodeIds.join(', ')}
        </p>
      )}
    </section>
  )
}

function ExecutionNodeCard({ data }: NodeProps<ExecutionFlowNode>) {
  return (
    <article className={css.executionNode} data-testid={`execution-node-${data.definition.id}`}>
      <Handle
        id="dependency"
        type="target"
        position={Position.Left}
        isConnectable={false}
      />
      <header>
        <div>
          <strong>
            {data.definition.label ?? data.catalog?.label ?? data.definition.type}
          </strong>
          <code>{data.definition.id}</code>
        </div>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
      </header>
      <div className={css.executionNodeMeta}>
        <code>{data.definition.type}</code>
        {data.catalog !== undefined && <span>{data.catalog.sourcePlugin}</span>}
      </div>
      <span className={css.executionNodeStage}>
        {data.stageLabel} {data.stage}
      </span>
      {data.branchPorts.length > 0 && (
        <div className={css.executionBranchPorts}>
          {data.branchPorts.map(port => (
            <span key={port} data-port={port}>
              {port}
              <Handle
                id={`branch:${port}`}
                className={css.executionBranchHandle}
                type="source"
                position={Position.Right}
                isConnectable={false}
              />
            </span>
          ))}
        </div>
      )}
      <Handle
        id="dependency"
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
    </article>
  )
}

/**
 * The execution pins worth labelling, by source node ID.
 *
 * Only a node that declares several pins has a branch to show; a lone `then` would label every edge.
 * @param dependencies - The reduced execution dependencies.
 * @param catalog - Registered node types by type.
 */
function branchPinsBySource(
  dependencies: readonly ExecutionDependency[],
  catalog: ReadonlyMap<string, NodeTypeSummary>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const branchPorts = new Map<string, Set<string>>()
  for (const dependency of dependencies) {
    const pin = dependency.execSourcePin
    if (pin === undefined || (catalog.get(dependency.source.type)?.execOutputs.length ?? 1) < 2) continue
    const ports = branchPorts.get(dependency.source.id) ?? new Set<string>()
    ports.add(pin)
    branchPorts.set(dependency.source.id, ports)
  }
  return branchPorts
}

function executionNodes(
  plan: ExecutionPlan,
  branchPorts: ReadonlyMap<string, ReadonlySet<string>>,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
  runRecords: ReadonlyMap<string, NodeRunRecord>,
  stageLabel: string,
): ExecutionFlowNode[] {
  return plan.stages.flatMap(stage => stage.nodes.map((item, index) => {
    const nodeType = catalog.get(item.node.type)
    const runRecord = runRecords.get(item.node.id)
    return {
      id: item.node.id,
      type: 'execution',
      position: {
        x: (stage.index - 1) * 300,
        y: index * 180,
      },
      data: {
        definition: item.node,
        ...(nodeType === undefined ? {} : { catalog: nodeType }),
        ...(runRecord === undefined ? {} : { runRecord }),
        stage: stage.index,
        stageLabel,
        branchPorts: [...(branchPorts.get(item.node.id) ?? [])]
          .sort(compareBranchPorts),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }
  }))
}

function executionEdges(
  dependencies: readonly ExecutionDependency[],
  branchPorts: ReadonlyMap<string, ReadonlySet<string>>,
): Edge[] {
  return dependencies.map((dependency) => {
    const pin = dependency.execSourcePin
    const branch = pin !== undefined && branchPorts.get(dependency.source.id)?.has(pin) === true
    return {
      id: `execution:${dependency.source.id}:${dependency.target.id}`,
      source: dependency.source.id,
      sourceHandle: branch ? `branch:${pin!}` : 'dependency',
      target: dependency.target.id,
      targetHandle: 'dependency',
      markerEnd: { type: MarkerType.ArrowClosed },
      ...(pin === undefined ? {} : { className: 'workflow-exec-edge' }),
    }
  })
}

function compareBranchPorts(left: string, right: string): number {
  const order = ['true', 'false']
  const leftIndex = order.indexOf(left)
  const rightIndex = order.indexOf(right)
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
  if (leftIndex === -1) return 1
  if (rightIndex === -1) return -1
  return leftIndex - rightIndex
}
