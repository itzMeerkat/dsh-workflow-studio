/**
 * DAG 引擎默认实现。
 *
 * 包含拓扑排序（Kahn）、层级执行、暂停恢复、HITL、运行记录持久化和启动时恢复。
 * 节点只有在其结束状态写入运行记录后才算完成；Host 停止时未完成的节点在恢复后重新调用（至少一次）。
 * @module dsh-workflow-studio
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import DagEngine from './engine.ts'
import type { DagRun } from './engine.ts'
import type {
  DagWorkflowDefinition, DagNodeDefinition, DagEdgeDefinition,
  NodeId,
  WorkflowResult, WorkflowSummary, WorkflowRunSummary, WorkflowRunRecord,
  NodeExecutionContext, NodeExecutionResult,
  NodeRunRecord, NodeRunStatus, PortDefinition,
  WorkflowRunStatus, NodeRunInfo, DagRunInfo,
  WorkflowNodeExecutor,
} from './types.ts'
import { WorkflowId, RunId } from './types.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import { workflowStudioDomainSpec } from './persistence.ts'
import { workflowRunsDomainSpec } from './run-persistence.ts'
import { workflowDefinitionSchema } from './workflow-schema.ts'
import { toJsonOutputs, toJsonValue } from './json.ts'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { CONFIRM_REQUEST_ID, confirmQuestions, confirmRejection, parseAnswer, parseQuestions } from './human-input.ts'

// ---- 内部状态 ----

interface NodeExecState {
  node: DagNodeDefinition
  record: NodeRunRecord
}

interface RunState {
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
  resultPromise: Promise<WorkflowResult>
  resultResolve: (result: WorkflowResult) => void
  /** 本运行的检查点写入按顺序排队。 */
  writeTail: Promise<void>
  /** 等待答案的节点请求，键为 `${nodeId}\u0000${requestId}`。 */
  inputWaiters: Map<string, (answer: AskUserQuestionAnswer) => void>
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set(['completed', 'failed', 'cancelled'])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- 拓扑排序 ----

interface TopoLevel {
  nodes: DagNodeDefinition[]
}

interface ResolvedNodePorts {
  inputs: readonly PortDefinition[]
  outputs: readonly PortDefinition[]
}

function portsAreCompatible(source: PortDefinition, target: PortDefinition): boolean {
  return source.type === 'any' || target.type === 'any' || source.type === target.type
}

/** 使用 Kahn 算法计算拓扑序。返回分层执行计划。*/
export function topologicalSort(definition: DagWorkflowDefinition): TopoLevel[] {
  const { nodes, edges } = definition
  const inDegree = new Map<NodeId, number>()
  const outEdges = new Map<NodeId, DagEdgeDefinition[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    outEdges.set(node.id, [])
  }

  for (const edge of edges) {
    const outgoing = outEdges.get(edge.source)
    if (outgoing === undefined) {
      throw new Error(`边 ${edge.id} 引用不存在的源节点 ${edge.source}`)
    }
    const targetDegree = inDegree.get(edge.target)
    if (targetDegree === undefined) {
      throw new Error(`边 ${edge.id} 引用不存在的目标节点 ${edge.target}`)
    }
    outgoing.push(edge)
    inDegree.set(edge.target, targetDegree + 1)
  }

  const nodeMap = new Map<NodeId, DagNodeDefinition>(
    nodes.map(n => [n.id, n]),
  )

  const levels: TopoLevel[] = []
  let frontier: NodeId[] = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id)

  while (frontier.length > 0) {
    const levelNodes: DagNodeDefinition[] = []
    const nextFrontier: NodeId[] = []

    for (const nodeId of frontier) {
      const nodeDef = nodeMap.get(nodeId)!
      levelNodes.push(nodeDef)

      for (const edge of outEdges.get(nodeId)!) {
        const target = edge.target
        const newDegree = inDegree.get(target)! - 1
        inDegree.set(target, newDegree)
        if (newDegree === 0) nextFrontier.push(target)
      }
    }

    levels.push({ nodes: levelNodes })
    frontier = nextFrontier
  }

  const sortedCount = levels.reduce((sum, l) => sum + l.nodes.length, 0)
  if (sortedCount !== nodes.length) {
    throw new Error(`工作流包含环：共 ${nodes.length} 个节点，仅 ${sortedCount} 个可排序`)
  }

  return levels
}

// ---- 引擎实现 ----

/**
 * 默认 DAG 引擎实现。
 * - 工作流定义通过 storage-domain 持久化
 * - 拓扑排序使用 Kahn 算法
 * - 同级节点并行执行
 * - 支持暂停/恢复
 * - HITL 通过暂停等待实现
 */
/** 引擎部署配置。 */
export interface DagEngineConfig {
  /** Host 重启后是否自动重新执行被中断的运行；为 false 时这些运行进入 interrupted。 */
  autoRestart: boolean
  /** 保留的已结束运行数量；超出时删除最早结束的运行记录。 */
  retainRuns: number
}

// ---- 引擎实现 ----

/**
 * 默认 DAG 引擎实现。
 * - 工作流定义和运行记录通过 storage-domain 持久化
 * - 拓扑排序使用 Kahn 算法，同级节点并行执行
 * - 支持暂停/恢复/取消，HITL 通过暂停等待实现
 * - Host 启动时恢复未结束的运行
 */
export class DagEngineProvider extends DagEngine {
  static inject = ['workflowNodeRegistry', 'storageDomain']

  static Config: z<DagEngineConfig> = z.object({
    autoRestart: z.boolean().default(true)
      .description('Host 重启后自动重新执行被中断的运行；节点或工作流节点可声明 recovery: hold 以要求人工恢复。'),
    retainRuns: z.natural().min(1).default(100).description('保留的已结束运行数量。'),
  })

  /** 启动时对已保存运行的恢复处理完成后兑现。 */
  recovered!: Promise<void>

  private workflows!: KvTable<WorkflowId, DagWorkflowDefinition>
  private runStore!: KvTable<RunId, WorkflowRunRecord>
  private readonly runs = new Map<RunId, RunState>()
  private readonly registry: WorkflowNodeRegistry
  private mutationTail: Promise<void> = Promise.resolve()
  private closing = false

  constructor(ctx: Context, private readonly config: DagEngineConfig) {
    super(ctx)
    this.registry = ctx.workflowNodeRegistry
  }

  /** 打开定义与运行 Domain，启动恢复，并在服务卸载时停止运行、等待写入完成后关闭。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workflowStudioDomainSpec)
    const openedRuns = await this.ctx.storageDomain.open(workflowRunsDomainSpec).catch(async (error: unknown) => {
      await domain.close()
      throw error
    })
    this.ctx.effect(() => async () => {
      // 停止时不写入运行的结束状态，使运行记录保持中断前的状态以便下次启动恢复。
      this.closing = true
      for (const state of this.runs.values()) {
        if (state.active) state.abortController.abort('Host 停止')
        this.releasePauseWaiters(state)
      }
      await Promise.all([...this.runs.values()].map(state => state.writeTail))
      await this.mutationTail
      await openedRuns.close()
      await domain.close()
    }, 'dagEngine.domainClose')
    this.workflows = domain.table('workflows')
    this.runStore = openedRuns.table('runs')
    this.recovered = this.recover()
  }

  /** 保存前验证所有可由当前注册表确定的不变量。 */
  private validateDefinition(definition: DagWorkflowDefinition): void {
    const nodePorts = new Map<NodeId, ResolvedNodePorts>()
    for (const node of definition.nodes) {
      if (nodePorts.has(node.id)) throw new Error(`节点 ID "${node.id}" 重复`)

      const executor = this.registry.get(node.type)
      if (executor === undefined) throw new Error(`未知节点类型: ${node.type}`)
      const inputs = this.resolveInputPorts(node, executor)
      const outputs = node.outputs ?? executor.outputs ?? []
      this.validatePorts(node.id, '输入', inputs)
      this.validatePorts(node.id, '输出', outputs)
      this.validateVariadicInputs(node, executor, inputs, outputs)
      nodePorts.set(node.id, { inputs, outputs })
    }

    const edgeIds = new Set<string>()
    const connectedInputs = new Set<string>()
    for (const edge of definition.edges) {
      if (edgeIds.has(edge.id)) throw new Error(`边 ID "${edge.id}" 重复`)
      edgeIds.add(edge.id)

      const source = nodePorts.get(edge.source)
      if (source === undefined) throw new Error(`边 ${edge.id} 引用不存在的源节点 ${edge.source}`)
      const target = nodePorts.get(edge.target)
      if (target === undefined) throw new Error(`边 ${edge.id} 引用不存在的目标节点 ${edge.target}`)

      const sourcePort = edge.sourcePort ?? 'output'
      const targetPort = edge.targetPort ?? 'input'
      const sourceDefinition = source.outputs.find(port => port.name === sourcePort)
      if (sourceDefinition === undefined) {
        throw new Error(`边 ${edge.id} 引用节点 ${edge.source} 不存在的输出端口 ${sourcePort}`)
      }
      const targetDefinition = target.inputs.find(port => port.name === targetPort)
      if (targetDefinition === undefined) {
        throw new Error(`边 ${edge.id} 引用节点 ${edge.target} 不存在的输入端口 ${targetPort}`)
      }
      if (!portsAreCompatible(sourceDefinition, targetDefinition)) {
        throw new Error(
          `边 ${edge.id} 的端口类型不兼容: ${edge.source}.${sourcePort}`
          + ` (${sourceDefinition.type}) -> ${edge.target}.${targetPort} (${targetDefinition.type})`,
        )
      }

      const inputKey = `${edge.target}\u0000${targetPort}`
      if (connectedInputs.has(inputKey)) {
        throw new Error(`节点 ${edge.target} 的输入端口 ${targetPort} 存在多条入边`)
      }
      connectedInputs.add(inputKey)
    }

    for (const [nodeId, ports] of nodePorts) {
      for (const port of ports.inputs) {
        if (port.required !== false && !connectedInputs.has(`${nodeId}\u0000${port.name}`)) {
          throw new Error(`节点 ${nodeId} 的输入端口 ${port.name} 缺少入边`)
        }
      }
    }

    topologicalSort(definition)
  }

  private validatePorts(nodeId: NodeId, kind: string, ports: readonly PortDefinition[]): void {
    const names = new Set<string>()
    for (const port of ports) {
      if (names.has(port.name)) throw new Error(`节点 ${nodeId} 的${kind}端口 ${port.name} 重复`)
      names.add(port.name)
    }
  }

  private resolveInputPorts(
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
  ): readonly PortDefinition[] {
    const declared = executor.inputs ?? []
    if (node.inputs === undefined) return declared
    // 带 role 的端口属于执行器；实例覆盖输入端口时保留执行器声明的这些端口。
    const instanceNames = new Set(node.inputs.map(port => port.name))
    return [...node.inputs, ...declared.filter(port => port.role !== undefined && !instanceNames.has(port.name))]
  }

  private validateVariadicInputs(
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    inputs: readonly PortDefinition[],
    outputs: readonly PortDefinition[],
  ): void {
    const constraint = executor.variadicInputs
    if (constraint === undefined) return
    if (inputs.length < constraint.min) {
      throw new Error(`节点 ${node.id} 至少需要 ${constraint.min} 个输入端口`)
    }
    const inputType = inputs[0]?.type
    if (inputs.some(port => port.type !== inputType)) {
      throw new Error(`节点 ${node.id} 的所有输入端口必须使用相同类型`)
    }
    if (constraint.outputType === 'same'
      && (outputs.length !== 1 || outputs[0]?.type !== inputType)) {
      throw new Error(`节点 ${node.id} 的输出端口必须与输入端口使用相同类型`)
    }
  }

  async save(definition: DagWorkflowDefinition): Promise<WorkflowId> {
    const snapshot = workflowDefinitionSchema.parse(definition)
    this.validateDefinition(snapshot)

    return this.enqueueMutation(async () => {
      const existing = this.findByName(snapshot.name)
      const id = existing !== undefined ? existing.id : WorkflowId(randomUUID())
      await this.workflows.put(id, snapshot)
      return id
    })
  }

  async update(id: WorkflowId, definition: DagWorkflowDefinition): Promise<WorkflowId> {
    const snapshot = workflowDefinitionSchema.parse(definition)
    this.validateDefinition(snapshot)
    return this.enqueueMutation(async () => {
      if (this.workflows.get(id) === undefined) {
        throw new Error(`工作流 "${id}" 不存在`)
      }
      const named = this.findByName(snapshot.name)
      if (named !== undefined && named.id !== id) {
        throw new Error(`工作流名称 "${snapshot.name}" 已存在`)
      }
      await this.workflows.put(id, snapshot)
      return id
    })
  }

  get(id: WorkflowId): DagWorkflowDefinition | undefined {
    const definition = this.workflows.get(id)
    return definition === undefined ? undefined : structuredClone(definition)
  }

  list(): WorkflowSummary[] {
    return [...this.workflows.entries()].map(([id, definition]) =>
      workflowSummary(id, definition))
  }

  findByName(name: string): WorkflowSummary | undefined {
    for (const [id, definition] of this.workflows.entries()) {
      if (definition.name === name) return workflowSummary(id, definition)
    }
    return undefined
  }

  start(workflowId: WorkflowId): DagRun {
    if (this.closing) throw new Error('工作流引擎正在关闭')
    const definition = this.get(workflowId)
    if (definition === undefined) throw new Error(`工作流 ${workflowId} 未找到`)
    const executors = this.resolveExecutors(definition)
    const runId = RunId(randomUUID())
    const now = Date.now()
    const state = this.createState({
      runId,
      workflowId,
      definition,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      nodes: definition.nodes.map(node => ({ nodeId: node.id, runId, status: 'pending', attempts: 0, startedAt: 0 })),
    })
    state.executors = executors
    this.runs.set(runId, state)
    this.emitEvent('dag/start', this.runInfo(state))
    this.launch(state)
    return this.handle(state)
  }

  getRun(runId: RunId): WorkflowResult | undefined {
    const state = this.runs.get(runId)
    if (state !== undefined) return this.snapshot(state)
    const record = this.runStore.get(runId)
    return record === undefined ? undefined : resultOfRecord(record)
  }

  getRunRecord(runId: RunId): WorkflowRunRecord | undefined {
    const state = this.runs.get(runId)
    if (state !== undefined) return this.toRecord(state)
    const record = this.runStore.get(runId)
    return record === undefined ? undefined : structuredClone(record)
  }

  listRuns(): WorkflowRunSummary[] {
    const summaries = new Map<RunId, WorkflowRunSummary>()
    for (const [runId, record] of this.runStore.entries()) summaries.set(runId, summaryOfRecord(record))
    for (const state of this.runs.values()) summaries.set(state.runId, summaryOfRecord(this.toRecord(state)))
    return [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  pauseRun(runId: RunId): void {
    const state = this.liveState(runId)
    if (state === undefined || !state.active || state.status !== 'running') return
    state.pauseRequested = true
  }

  resumeRun(runId: RunId): void {
    if (this.closing) throw new Error('工作流引擎正在关闭')
    const state = this.liveState(runId)
    if (state === undefined) return
    if (state.active) {
      state.pauseRequested = false
      if (state.status !== 'paused') return
      state.status = 'running'
      this.emitEvent('dag/resumed', this.runInfo(state))
      this.checkpointInBackground(state)
      this.releasePauseWaiters(state)
      return
    }
    // 未执行的 paused/interrupted 运行：按当前注册表重新解析执行器后继续调度。
    state.executors = this.resolveExecutors(state.definition)
    state.status = 'running'
    delete state.error
    this.emitEvent('dag/resumed', this.runInfo(state))
    this.launch(state)
  }

  cancelRun(runId: RunId, reason?: string): void {
    const state = this.liveState(runId)
    if (state === undefined) return
    const message = reason ?? 'cancelled'
    if (state.active) {
      state.abortController.abort(message)
      this.releasePauseWaiters(state)
      return
    }
    this.cancelRemaining(state, message)
    void this.finishRun(state, this.workflowResult(state, 'cancelled', message))
  }

  /**
   * 未结束运行的内存状态。已结束运行返回 undefined；未知运行抛出。
   * @param runId - 运行 ID。
   */
  private liveState(runId: RunId): RunState | undefined {
    const state = this.runs.get(runId)
    if (state !== undefined) return state
    if (this.runStore.get(runId) !== undefined) return undefined
    throw new Error(`运行 ${runId} 不存在`)
  }

  private handle(state: RunState): DagRun {
    const meta: { name: string; description?: string } = { name: state.definition.name }
    if (state.definition.description !== undefined) meta.description = state.definition.description
    return {
      runId: state.runId,
      meta,
      result: state.resultPromise,
      pause: () => { this.pauseRun(state.runId) },
      resume: () => { this.resumeRun(state.runId) },
      cancel: (reason?: string) => { this.cancelRun(state.runId, reason) },
      dispose: async () => {
        this.cancelRun(state.runId, 'dispose')
        await state.resultPromise
      },
    }
  }

  // ---- 持久化与恢复 ----

  private createState(record: WorkflowRunRecord): RunState {
    const { promise: resultPromise, resolve: resultResolve } = Promise.withResolvers<WorkflowResult>()
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
      inputWaiters: new Map(),
    }
  }

  private toRecord(state: RunState): WorkflowRunRecord {
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
   * 将运行的当前状态排队写入运行记录。引擎关闭后不再写入。
   * @returns 该次写入持久化后兑现；写入失败时拒绝。
   */
  private checkpoint(state: RunState): Promise<void> {
    if (this.closing) return Promise.resolve()
    state.updatedAt = Date.now()
    const record = this.toRecord(state)
    const write = state.writeTail.then(async () => {
      if (!this.closing) await this.runStore.put(state.runId, record)
    })
    state.writeTail = write.catch(() => {})
    return write
  }

  private checkpointInBackground(state: RunState): void {
    this.checkpoint(state).catch((error: unknown) => {
      this.ctx.logger.warn(`dag: 运行 ${state.runId} 检查点写入失败: ${messageOf(error)}`)
    })
  }

  /** 等待节点注册完成后，恢复上次停止时未结束的运行。 */
  private async recover(): Promise<void> {
    await this.ctx.get('loader')?.await()
    if (this.closing) return
    for (const [runId, record] of [...this.runStore.entries()]) {
      if (TERMINAL_STATUSES.has(record.status) || this.runs.has(runId)) continue
      let state: RunState
      try {
        state = this.createState(record)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dag: 无法恢复运行 ${runId}: ${messageOf(error)}`)
        continue
      }
      const interrupted: NodeId[] = []
      for (const { record: nodeRecord } of state.nodeStates.values()) {
        if (nodeRecord.status !== 'running' && nodeRecord.status !== 'awaiting-input') continue
        // 仍在等待执行前确认的节点尚未调用执行器，重新调用总是安全的，不受 recovery 策略约束。
        if (!awaitingConfirmation(nodeRecord)) interrupted.push(nodeRecord.nodeId)
        nodeRecord.status = 'pending'
        delete nodeRecord.outputs
        delete nodeRecord.error
        delete nodeRecord.completedAt
      }
      this.runs.set(runId, state)
      if (record.status === 'running') this.restartInterrupted(state, interrupted)
    }
  }

  /** 按部署配置和节点恢复策略决定自动重新执行或等待人工恢复。 */
  private restartInterrupted(state: RunState, interrupted: readonly NodeId[]): void {
    if (!this.config.autoRestart) {
      this.interrupt(state, 'Host 重启后未自动恢复（autoRestart 已关闭）')
      return
    }
    let executors: Map<NodeId, WorkflowNodeExecutor>
    try {
      executors = this.resolveExecutors(state.definition)
    } catch (error: unknown) {
      this.interrupt(state, `无法恢复: ${messageOf(error)}`)
      return
    }
    const held = interrupted.filter((nodeId) => {
      const node = this.nodeState(state, nodeId).node
      return (node.recovery ?? executors.get(nodeId)?.recovery ?? 'rerun') === 'hold'
    })
    if (held.length > 0) {
      this.interrupt(state, `节点 ${held.join(', ')} 需要人工恢复后重新执行`)
      return
    }
    state.executors = executors
    state.status = 'running'
    this.emitEvent('dag/resumed', this.runInfo(state))
    this.launch(state)
  }

  private interrupt(state: RunState, reason: string): void {
    state.status = 'interrupted'
    state.error = reason
    this.checkpointInBackground(state)
    this.emitEvent('dag/interrupted', this.runInfo(state), reason)
  }

  /** 删除超出保留数量的最早结束的运行记录。 */
  private async pruneRuns(): Promise<void> {
    const finished = [...this.runStore.entries()]
      .filter(([runId, record]) => TERMINAL_STATUSES.has(record.status) && !this.runs.has(runId))
      .sort(([, a], [, b]) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt) || b.startedAt - a.startedAt)
    for (const [runId] of finished.slice(this.config.retainRuns)) {
      if (this.closing) return
      await this.runStore.delete(runId)
    }
  }

  /** 按当前注册表验证定义并解析每个节点的执行器。 */
  private resolveExecutors(definition: DagWorkflowDefinition): Map<NodeId, WorkflowNodeExecutor> {
    this.validateDefinition(definition)
    const executors = new Map<NodeId, WorkflowNodeExecutor>()
    for (const node of definition.nodes) {
      const executor = this.registry.get(node.type)
      if (executor === undefined) throw new Error(`节点类型 ${node.type} 未注册`)
      executors.set(node.id, executor)
    }
    return executors
  }

  // ---- 暂停/恢复 ----

  private releasePauseWaiters(state: RunState): void {
    for (const resolve of state.pauseResolvers) resolve()
    state.pauseResolvers.clear()
  }

  private waitForResume(state: RunState): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    state.pauseResolvers.add(resolve)
    return promise.finally(() => {
      state.pauseResolvers.delete(resolve)
    })
  }

  private async checkPause(state: RunState): Promise<void> {
    if (!state.pauseRequested || state.status !== 'running') return
    const resumed = this.waitForResume(state)
    state.status = 'paused'
    this.emitEvent('dag/paused', this.runInfo(state))
    await this.checkpoint(state)
    await resumed
  }

  // ---- 人工输入 ----

  async answerInput(runId: RunId, nodeId: NodeId, requestId: string, answer: unknown): Promise<void> {
    const state = this.liveState(runId)
    if (state === undefined) throw new Error(`运行 ${runId} 已结束`)
    const execState = state.nodeStates.get(nodeId)
    if (execState === undefined) throw new Error(`运行 ${runId} 没有节点 ${nodeId}`)
    const request = execState.record.interactions?.find(item => item.id === requestId)
    if (request === undefined) throw new Error(`节点 ${nodeId} 没有请求 ${requestId}`)
    if (request.answer !== undefined) throw new Error(`请求 ${requestId} 已回答`)
    const parsed = parseAnswer(request.questions, answer)
    request.answer = parsed
    request.answeredAt = Date.now()
    await this.checkpoint(state)
    this.emitEvent('dag/input-answered', this.runInfo(state), nodeId, requestId)
    state.inputWaiters.get(inputKey(nodeId, requestId))?.(structuredClone(parsed))
  }

  /**
   * 发起或复用节点的人工输入请求并等待答案。
   * @param allowReserved - 引擎自身的请求可使用保留前缀。
   */
  private async askHuman(
    state: RunState,
    execState: NodeExecState,
    nodeInfo: NodeRunInfo,
    requestId: string,
    questions: AskUserQuestionItem[],
    signal: AbortSignal,
    allowReserved = false,
  ): Promise<AskUserQuestionAnswer> {
    const parsed = parseQuestions(requestId, questions, allowReserved)
    const record = execState.record
    record.interactions ??= []
    let request = record.interactions.find(item => item.id === requestId)
    if (request?.answer !== undefined) return structuredClone(request.answer)
    signal.throwIfAborted()
    if (request === undefined) {
      request = { id: requestId, questions: parsed, askedAt: Date.now() }
      record.interactions.push(request)
    }
    const key = inputKey(record.nodeId, requestId)
    const { promise, resolve } = Promise.withResolvers<AskUserQuestionAnswer>()
    state.inputWaiters.set(key, resolve)
    record.status = 'awaiting-input'
    try {
      await this.checkpoint(state)
      this.emitEvent('dag/input-requested', this.runInfo(state), { ...nodeInfo, status: 'awaiting-input' }, requestId)
      return await abortable(promise, signal)
    } finally {
      state.inputWaiters.delete(key)
      if (record.status === 'awaiting-input' && !hasWaiter(state, record.nodeId)) record.status = 'running'
    }
  }

  // ---- 执行引擎 ----

  /** 开始调度运行中未结束的节点，并在结束后写入最终状态。 */
  private launch(state: RunState): void {
    state.active = true
    state.pauseRequested = false
    state.abortController = new AbortController()
    this.checkpoint(state)
      .then(() => this.executeWorkflow(state))
      .catch((error: unknown) => this.workflowResult(state, 'failed', messageOf(error)))
      .then(result => this.finishRun(state, result))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`dag: 运行 ${state.runId} 结束处理失败: ${messageOf(error)}`)
      })
  }

  private async finishRun(state: RunState, result: WorkflowResult): Promise<void> {
    state.active = false
    state.status = result.status
    state.completedAt = result.completedAt ?? Date.now()
    if (result.error !== undefined) state.error = result.error
    this.emitEvent('dag/end', this.runInfo(state), {
      status: result.status,
      ...(result.error === undefined ? {} : { error: result.error }),
    })
    try {
      await this.checkpoint(state)
    } catch (error: unknown) {
      this.ctx.logger.warn(`dag: 运行 ${state.runId} 最终状态写入失败: ${messageOf(error)}`)
    }
    try {
      if (!this.closing) {
        this.runs.delete(state.runId)
        await this.enqueueMutation(() => this.pruneRuns())
      }
    } finally {
      state.resultResolve(structuredClone(result))
    }
  }

  private async executeWorkflow(state: RunState): Promise<WorkflowResult> {
    const levels = topologicalSort(state.definition)
    const signal = state.abortController.signal

    try {
      for (const level of levels) {
        const pending = level.nodes.filter(node => this.nodeState(state, node.id).record.status === 'pending')
        if (pending.length === 0) continue
        if (signal.aborted) {
          this.cancelRemaining(state, signal.reason)
          break
        }

        // 层级间检查暂停
        await this.checkPause(state)
        if (signal.aborted) {
          this.cancelRemaining(state, signal.reason)
          break
        }

        // 同级并行
        await Promise.all(pending.map(node => this.executeNode(state, node, signal)))
        const failed = pending
          .map(node => this.nodeState(state, node.id).record)
          .filter(record => record.status === 'failed')
        if (failed.length > 0) {
          const error = failed.map(record => `${record.nodeId}: ${record.error ?? '节点执行失败'}`).join('; ')
          this.cancelRemaining(state, error)
          return this.workflowResult(state, 'failed', error)
        }
      }

      if (signal.aborted) this.cancelRemaining(state, signal.reason)
      return this.workflowResult(
        state,
        signal.aborted ? 'cancelled' : 'completed',
        signal.aborted && signal.reason !== undefined ? String(signal.reason) : undefined,
      )
    } catch (error: unknown) {
      const message = messageOf(error)
      this.cancelRemaining(state, message)
      return this.workflowResult(state, 'failed', message)
    }
  }

  /** 执行一个节点；开始和结束状态都在写入运行记录后才返回。 */
  private async executeNode(state: RunState, node: DagNodeDefinition, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const execState = this.nodeState(state, node.id)
    const executor = this.executor(state, node.id)
    const inputs = this.collectInputs(node, state)
    const record = execState.record
    record.attempts += 1
    record.status = 'running'
    record.startedAt = Date.now()
    record.inputs = structuredClone(inputs)
    const nodeInfo: NodeRunInfo = {
      nodeId: node.id,
      nodeType: node.type,
      label: node.label ?? node.type,
      status: 'running',
    }
    this.emitEvent('dag/node-start', this.runInfo(state), nodeInfo)
    await this.checkpoint(state)
    await this.runNode(state, node, executor, execState, nodeInfo, inputs, signal)
    await this.checkpoint(state)
  }

  private async runNode(
    state: RunState,
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    execState: NodeExecState,
    nodeInfo: NodeRunInfo,
    inputs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const definition = state.definition
    const inputPorts = this.resolveInputPorts(node, executor)
    const businessInputPorts = inputPorts.filter(port => port.role === undefined)
    const suppliedInputs = businessInputPorts.filter(port => Object.hasOwn(inputs, port.name))
    const requiredInputPorts = inputPorts.filter(port => port.required !== false)
    const connected = new Set(definition.edges
      .filter(edge => edge.target === node.id)
      .map(edge => edge.targetPort ?? 'input'))
    const record = execState.record

    const context: NodeExecutionContext = {
      runId: state.runId,
      config: node.config,
      inputs,
      connected,
      invocationKey: `${state.runId}/${node.id}`,
      notepad: {
        get value() {
          return record.notepad === undefined ? undefined : structuredClone(record.notepad)
        },
        save: async (value) => {
          record.notepad = toJsonValue(value, 'notepad')
          await this.checkpoint(state)
        },
      },
      askHuman: async (requestId, questions) =>
        this.askHuman(state, execState, nodeInfo, requestId, questions, signal),
      signal,
      log: (msg: string) => {
        this.ctx.logger.info(`[${state.definition.name}/${node.label ?? node.type}] ${msg}`)
      },
    }

    let preflight: NodeExecutionResult | undefined
    try {
      preflight = executor.preflight?.(context)
    } catch (error: unknown) {
      this.failNode(state, execState, nodeInfo, messageOf(error))
      return
    }
    if (preflight !== undefined) {
      this.settleNode(state, node, executor, execState, nodeInfo, preflight)
      return
    }

    if (requiredInputPorts.length > 0 && suppliedInputs.length === 0) {
      this.completeNode(state, execState, nodeInfo, 'skipped', {})
      return
    }
    const missing = requiredInputPorts
      .filter(port => !Object.hasOwn(inputs, port.name))
      .map(port => port.name)
    if (missing.length > 0) {
      const skippedDependency = definition.edges.some(edge =>
        edge.target === node.id
        && missing.includes(edge.targetPort ?? 'input')
        && this.nodeState(state, edge.source).record.status === 'skipped')
      if (skippedDependency) {
        this.completeNode(state, execState, nodeInfo, 'skipped', {})
        return
      }
      this.failNode(state, execState, nodeInfo, `缺少输入端口: ${missing.join(', ')}`)
      return
    }

    // 执行前人工确认：拒绝时节点失败。
    if (executor.requiresHumanInput === true || node.requiresHumanInput === true) {
      let answer: AskUserQuestionAnswer
      try {
        answer = await this.askHuman(
          state, execState, nodeInfo, CONFIRM_REQUEST_ID, confirmQuestions(node), signal, true,
        )
      } catch (error: unknown) {
        if (!signal.aborted) throw error
        this.completeNode(state, execState, nodeInfo, 'cancelled')
        return
      }
      const rejection = confirmRejection(answer)
      if (rejection !== undefined) {
        this.failNode(state, execState, nodeInfo, rejection)
        return
      }
    }

    try {
      const result = await executor.execute(context)
      if (signal.aborted) {
        this.completeNode(state, execState, nodeInfo, 'cancelled')
      } else {
        this.settleNode(state, node, executor, execState, nodeInfo, result)
      }
    } catch (error: unknown) {
      this.failNode(state, execState, nodeInfo, messageOf(error))
    }
  }

  /** 按节点返回的结果结束节点；completed 结果的输出须为已声明端口的 JSON 值。 */
  private settleNode(
    state: RunState,
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    execState: NodeExecState,
    nodeInfo: NodeRunInfo,
    result: NodeExecutionResult,
  ): void {
    switch (result.status) {
      case 'completed': {
        let outputs: Record<string, unknown>
        try {
          this.validateOutputs(node, executor, result)
          outputs = toJsonOutputs(result.outputs, `节点 ${node.id} 的输出`)
        } catch (error: unknown) {
          this.failNode(state, execState, nodeInfo, messageOf(error))
          return
        }
        this.completeNode(state, execState, nodeInfo, 'completed', outputs)
        return
      }
      case 'failed': {
        let outputs: Record<string, unknown> | undefined
        try {
          outputs = result.outputs === undefined ? undefined : toJsonOutputs(result.outputs, `节点 ${node.id} 的输出`)
        } catch (error: unknown) {
          this.failNode(state, execState, nodeInfo, `${result.error}（诊断输出已丢弃: ${messageOf(error)}）`)
          return
        }
        this.failNode(state, execState, nodeInfo, result.error, outputs)
        return
      }
      case 'skipped':
        this.completeNode(state, execState, nodeInfo, 'skipped', {})
        return
      default:
        return assertNever(result)
    }
  }

  /** 收集上游输出到当前节点的输入端口。 */
  private collectInputs(node: DagNodeDefinition, state: RunState): Record<string, unknown> {
    const incomingEdges = state.definition.edges.filter(e => e.target === node.id)
    const inputs: Record<string, unknown> = {}
    for (const edge of incomingEdges) {
      const sourceState = this.nodeState(state, edge.source)
      const sourcePort = edge.sourcePort ?? 'output'
      const targetPort = edge.targetPort ?? 'input'
      const outputs = sourceState.record.outputs
      if (outputs !== undefined && Object.hasOwn(outputs, sourcePort)) {
        inputs[targetPort] = outputs[sourcePort]
      }
    }
    return inputs
  }

  private cancelRemaining(state: RunState, reason: unknown): void {
    for (const [, execState] of state.nodeStates) {
      if (execState.record.status === 'pending') {
        execState.record.status = 'cancelled'
        if (reason !== undefined) execState.record.error = String(reason)
        execState.record.completedAt = Date.now()
      }
    }
  }

  private nodeState(state: RunState, nodeId: NodeId): NodeExecState {
    const nodeState = state.nodeStates.get(nodeId)
    if (nodeState === undefined) throw new Error(`运行状态缺少节点 ${nodeId}`)
    return nodeState
  }

  private executor(state: RunState, nodeId: NodeId): WorkflowNodeExecutor {
    const executor = state.executors.get(nodeId)
    if (executor === undefined) throw new Error(`运行状态缺少节点 ${nodeId} 的执行器`)
    return executor
  }

  private validateOutputs(
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    result: NodeExecutionResult & { status: 'completed' },
  ): void {
    const declared = new Set((node.outputs ?? executor.outputs ?? []).map(port => port.name))
    for (const name of Object.keys(result.outputs)) {
      if (!declared.has(name)) throw new Error(`节点 ${node.id} 返回未声明的输出端口 ${name}`)
    }
  }

  private completeNode(
    state: RunState,
    execState: NodeExecState,
    nodeInfo: NodeRunInfo,
    status: Extract<NodeRunStatus, 'completed' | 'skipped' | 'cancelled'>,
    outputs?: Record<string, unknown>,
  ): void {
    execState.record.status = status
    if (outputs !== undefined) execState.record.outputs = structuredClone(outputs)
    if (status === 'cancelled' && state.abortController.signal.reason !== undefined) {
      execState.record.error = String(state.abortController.signal.reason)
    }
    execState.record.completedAt = Date.now()
    this.emitEvent('dag/node-end', this.runInfo(state), { ...nodeInfo, status })
  }

  private failNode(
    state: RunState,
    execState: NodeExecState,
    nodeInfo: NodeRunInfo,
    error: string,
    outputs?: Record<string, unknown>,
  ): void {
    execState.record.status = 'failed'
    execState.record.error = error
    if (outputs !== undefined) execState.record.outputs = structuredClone(outputs)
    execState.record.completedAt = Date.now()
    this.emitEvent('dag/node-end', this.runInfo(state), { ...nodeInfo, status: 'failed' })
  }

  private snapshot(state: RunState): WorkflowResult {
    return resultOfRecord(this.toRecord(state))
  }

  private workflowResult(state: RunState, status: WorkflowRunStatus, error?: string): WorkflowResult {
    return {
      runId: state.runId,
      workflowId: state.workflowId,
      name: state.definition.name,
      status,
      nodeRecords: structuredClone([...state.nodeStates.values()].map(item => item.record)),
      startedAt: state.startedAt,
      completedAt: Date.now(),
      ...(error === undefined ? {} : { error }),
    }
  }

  private runInfo(state: RunState): DagRunInfo {
    return {
      runId: state.runId,
      workflowId: state.workflowId,
      name: state.definition.name,
      status: state.status,
    }
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }
}

function workflowSummary(
  id: WorkflowId,
  definition: DagWorkflowDefinition,
): WorkflowSummary {
  return {
    id,
    name: definition.name,
    ...(definition.description === undefined ? {} : { description: definition.description }),
  }
}

function resultOfRecord(record: WorkflowRunRecord): WorkflowResult {
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    name: record.definition.name,
    status: record.status,
    nodeRecords: structuredClone(record.nodes),
    startedAt: record.startedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

function summaryOfRecord(record: WorkflowRunRecord): WorkflowRunSummary {
  const awaitingInput = TERMINAL_STATUSES.has(record.status)
    ? 0
    : record.nodes.reduce((count, node) =>
      count + (node.interactions ?? []).filter(item => item.answer === undefined).length, 0)
  return {
    runId: record.runId,
    workflowId: record.workflowId,
    name: record.definition.name,
    status: record.status,
    awaitingInput,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

function inputKey(nodeId: NodeId, requestId: string): string {
  return `${nodeId}\u0000${requestId}`
}

function hasWaiter(state: RunState, nodeId: NodeId): boolean {
  const prefix = `${nodeId}\u0000`
  for (const key of state.inputWaiters.keys()) if (key.startsWith(prefix)) return true
  return false
}

/** 节点仅在等待执行前确认、尚未调用执行器。 */
function awaitingConfirmation(record: NodeRunRecord): boolean {
  const pending = (record.interactions ?? []).filter(item => item.answer === undefined)
  return record.status === 'awaiting-input' && pending.length === 1 && pending[0]?.id === CONFIRM_REQUEST_ID
}

/** 在信号中止时以中止原因拒绝。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function assertNever(value: never): never {
  throw new Error(`未知的节点执行结果: ${JSON.stringify(value)}`)
}
