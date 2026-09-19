/**
 * 运行的内存状态及其与运行记录之间的转换。
 * @module dsh-workflow-studio
 */

import type {
  DagNodeDefinition, DagRunInfo, DagWorkflowDefinition, JsonValue, NodeId, NodeRunRecord, RunId, WorkflowId,
  WorkflowNodeExecutor, WorkflowRunRecord, WorkflowRunStatus, WorkflowRunSummary,
} from './shared/types.ts'

/** 节点定义与其运行记录。 */
export interface NodeExecState {
  node: DagNodeDefinition
  record: NodeRunRecord
}

/** 引擎持有的一个运行的内存状态。 */
export interface RunState {
  runId: RunId
  workflowId: WorkflowId
  definition: DagWorkflowDefinition
  /** 执行中的节点执行器；运行未执行时为空。 */
  executors: Map<NodeId, WorkflowNodeExecutor>
  status: WorkflowRunStatus
  nodeStates: Map<NodeId, NodeExecState>
  startedAt: number
  updatedAt: number
  completedAt?: number
  error?: string
  /** 调度循环正在执行本运行；恢复后等待人工处理的运行为 false。 */
  active: boolean
  abortController: AbortController
  pauseRequested: boolean
  pauseResolvers: Set<() => void>
  resultPromise: Promise<WorkflowRunRecord>
  resultResolve: (result: WorkflowRunRecord) => void
  /** 本运行的检查点写入按顺序排队。 */
  writeTail: Promise<void>
  /** 等待结果送达的节点请求，按节点 ID 和请求 ID 索引。 */
  signalWaiters: Map<NodeId, Map<string, (result: JsonValue) => void>>
}

/** 运行的结束状态。 */
export const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['completed', 'failed', 'cancelled'])

/**
 * 从运行记录创建内存状态；节点记录被复制。
 * @param record - 新建或读回的运行记录。
 * @returns 未执行的运行状态。
 * @throws 记录包含定义中不存在的节点时。
 */
export function createRunState(record: WorkflowRunRecord): RunState {
  const { promise: resultPromise, resolve: resultResolve } = Promise.withResolvers<WorkflowRunRecord>()
  const nodes = new Map(record.definition.nodes.map(node => [node.id, node]))
  const nodeStates = new Map<NodeId, NodeExecState>()
  for (const nodeRecord of record.nodes) {
    const node = nodes.get(nodeRecord.nodeId)
    if (node === undefined) throw new Error(`运行 ${record.runId} 的记录包含定义中不存在的节点 ${nodeRecord.nodeId}`)
    nodeStates.set(node.id, { node, record: structuredClone(nodeRecord) })
  }
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    definition: record.definition,
    executors: new Map(),
    status: record.status,
    nodeStates,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
    active: false,
    abortController: new AbortController(),
    pauseRequested: false,
    pauseResolvers: new Set(),
    resultPromise,
    resultResolve,
    writeTail: Promise.resolve(),
    signalWaiters: new Map(),
  }
}

/**
 * 运行状态的独立记录快照。
 * @param state - 运行状态。
 * @returns 可持久化或返回给调用方的运行记录。
 */
export function toRunRecord(state: RunState): WorkflowRunRecord {
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    definition: structuredClone(state.definition),
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    nodes: structuredClone([...state.nodeStates.values()].map(item => item.record)),
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

/**
 * 运行列表中的一行；已结束运行没有待送达请求。
 * @param record - 运行记录。
 */
export function summaryOfRecord(record: WorkflowRunRecord): WorkflowRunSummary {
  const pendingRequests = TERMINAL_STATUSES.has(record.status)
    ? 0
    : record.nodes.reduce((count, node) =>
      count + (node.requests ?? []).filter(item => item.result === undefined).length, 0)
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    name: record.definition.name,
    status: record.status,
    pendingRequests,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/**
 * 运行中的节点状态。
 * @param state - 运行状态。
 * @param nodeId - 定义中的节点 ID。
 * @throws 运行不包含该节点时。
 */
export function nodeState(state: RunState, nodeId: NodeId): NodeExecState {
  const execState = state.nodeStates.get(nodeId)
  if (execState === undefined) throw new Error(`运行状态缺少节点 ${nodeId}`)
  return execState
}

/**
 * 事件负载中的运行信息。
 * @param state - 运行状态。
 */
export function runInfo(state: RunState): DagRunInfo {
  return { runId: state.runId, workflowId: state.workflowId, name: state.definition.name, status: state.status }
}

/**
 * 唤醒所有等待运行恢复的调度循环。
 * @param state - 运行状态。
 */
export function releasePauseWaiters(state: RunState): void {
  for (const resolve of state.pauseResolvers) resolve()
  state.pauseResolvers.clear()
}

/**
 * 将所有 pending 节点标记为 cancelled。
 * @param state - 运行状态。
 * @param reason - 写入节点记录的原因；undefined 时不写。
 */
export function cancelRemaining(state: RunState, reason: unknown): void {
  for (const { record } of state.nodeStates.values()) {
    if (record.status !== 'pending') continue
    record.status = 'cancelled'
    if (reason !== undefined) record.error = String(reason)
    record.completedAt = Date.now()
  }
}
