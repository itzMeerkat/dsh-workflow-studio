/** Read-only graph of the scheduler's node execution dependencies, grouped into stage columns. */

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
} from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import { useMemo } from 'react'
import type { DagWorkflowDefinition, NodeRunRecord, NodeTypeSummary } from '../shared/types.ts'
import type { WorkflowNodeData } from './graph-model.ts'
import type { ExecutionDependency, ExecutionPlan } from './model.ts'
import {
  createExecutionPlan,
  reduceExecutionDependencies,
} from './model.ts'
import { executionLayout } from './execution-layout.ts'
import type { Translate } from './locale.ts'
import { NodeCard, NodeCardContext } from './NodeCard.tsx'
import css from './WorkflowStudioPanel.module.css'

type ExecutionNodeData = WorkflowNodeData & { branchPins: readonly string[] }
type StageNodeData = { label: string } & Record<string, unknown>

type ExecutionFlowNode = Node<ExecutionNodeData, 'execution'> | Node<StageNodeData, 'stage'>
const executionNodeTypes = { execution: ExecutionNodeCard, stage: StageBand }

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
  const branchPins = useMemo(() => branchPinsBySource(dependencies, catalog), [catalog, dependencies])
  const nodes = useMemo(
    () => executionNodes(plan, branchPins, catalog, runRecords, t('execution.stage')),
    [branchPins, catalog, plan, runRecords, t],
  )
  const edges = useMemo(() => executionEdges(dependencies, branchPins), [branchPins, dependencies])

  return (
    <section className={css.executionView} aria-label={t('execution.title')}>
      <div className={`${css.canvas} ${css.executionCanvas}`}>
        <NodeCardContext.Provider value={{ t }}>
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
            fitViewOptions={{ padding: 0.16 }}
            minZoom={0.4}
            maxZoom={1.5}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            <Controls showInteractive={false} />
            <Panel position="top-right" className={css.executionSummary}>
              {plan.stages.length} {t('execution.stages')}
              <b aria-hidden="true">·</b>
              {definition.nodes.length} {t('execution.nodes')}
            </Panel>
          </ReactFlow>
        </NodeCardContext.Provider>
      </div>

      {plan.cyclicNodeIds.length > 0 && (
        <p className={css.executionCycle} role="alert">
          {t('execution.cycle')}: {plan.cyclicNodeIds.join(', ')}
        </p>
      )}
    </section>
  )
}

function ExecutionNodeCard({ data }: NodeProps<Node<ExecutionNodeData, 'execution'>>) {
  return (
    <div data-testid={`execution-node-${data.definition.id}`}>
      <NodeCard data={data} graph="execution" branchPins={data.branchPins} />
    </div>
  )
}

/** The band a stage's cards sit in; it names the stage instead of every card repeating it. */
function StageBand({ data }: NodeProps<Node<StageNodeData, 'stage'>>) {
  return <div className={css.executionStage}><span>{data.label}</span></div>
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
  const branchPins = new Map<string, Set<string>>()
  for (const dependency of dependencies) {
    const pin = dependency.execSourcePin
    if (pin === undefined || (catalog.get(dependency.source.type)?.execOutputs.length ?? 1) < 2) continue
    const pins = branchPins.get(dependency.source.id) ?? new Set<string>()
    pins.add(pin)
    branchPins.set(dependency.source.id, pins)
  }
  return branchPins
}

/**
 * Stage bands, each followed by the cards it holds.
 *
 * React Flow draws a parent before its children and positions a child relative to it, so a band
 * both labels its stage and holds its column together.
 * @param plan - The stages to lay out.
 * @param branchPins - Labelled execution pins by source node ID.
 * @param catalog - Registered node types by type.
 * @param runRecords - Latest run records by node ID.
 * @param stageLabel - Localized word naming one stage.
 */
function executionNodes(
  plan: ExecutionPlan,
  branchPins: ReadonlyMap<string, ReadonlySet<string>>,
  catalog: ReadonlyMap<string, NodeTypeSummary>,
  runRecords: ReadonlyMap<string, NodeRunRecord>,
  stageLabel: string,
): ExecutionFlowNode[] {
  const cards = new Map(plan.stages.flatMap(stage => stage.nodes.map((item) => {
    const nodeType = catalog.get(item.node.type)
    const runRecord = runRecords.get(item.node.id)
    return [item.node.id, {
      definition: item.node,
      ...(nodeType === undefined ? {} : { catalog: nodeType }),
      ...(runRecord === undefined ? {} : { runRecord }),
      branchPins: [...(branchPins.get(item.node.id) ?? [])].sort(compareBranchPins),
    } satisfies ExecutionNodeData] as const
  })))
  const layout = executionLayout(
    plan.stages.map(stage => stage.nodes.map(item => cards.get(item.node.id)!)),
    stageLabel,
  )
  return [
    ...layout.bands.map((band): ExecutionFlowNode => ({
      id: band.id,
      type: 'stage',
      position: { x: band.x, y: band.y },
      data: { label: band.label },
      style: { width: band.width, height: band.height },
      draggable: false,
      selectable: false,
    })),
    ...layout.cards.map((card): ExecutionFlowNode => ({
      id: card.nodeId,
      type: 'execution',
      parentId: card.bandId,
      position: { x: card.x, y: card.y },
      data: cards.get(card.nodeId)!,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    })),
  ]
}

function executionEdges(
  dependencies: readonly ExecutionDependency[],
  branchPins: ReadonlyMap<string, ReadonlySet<string>>,
): Edge[] {
  return dependencies.map((dependency) => {
    const pin = dependency.execSourcePin
    const branch = pin !== undefined && branchPins.get(dependency.source.id)?.has(pin) === true
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

function compareBranchPins(left: string, right: string): number {
  const order = ['true', 'false']
  const leftIndex = order.indexOf(left)
  const rightIndex = order.indexOf(right)
  if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
  if (leftIndex === -1) return 1
  if (rightIndex === -1) return -1
  return leftIndex - rightIndex
}
