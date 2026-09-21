/**
 * DAG 引擎默认实现。
 *
 * 包含工作流定义存储、运行控制、人工输入回答、运行记录持久化和启动时恢复；节点调度见 {@link RunExecutor}。
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
  DagWorkflowDefinition, NodeId, WorkflowSummary, WorkflowRunSummary, WorkflowRunRecord, WorkflowNodeExecutor,
} from './shared/types.ts'
import { WorkflowId, RunId } from './shared/types.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import { registerFlowControlNodes } from './flow-nodes.ts'
import { workflowRunsDomainSpec, workflowStudioDomainSpec } from './persistence.ts'
import { messageOf } from './shared/errors.ts'
import { resolveExecutors } from './validation.ts'
import { uniqueWorkflowSlug } from './shared/slug.ts'
import {
  TERMINAL_STATUSES, cancelRemaining, createRunState, nodeState, releasePauseWaiters, runInfo,
  summaryOfRecord, toRunRecord, type RunState,
} from './run-state.ts'
import { RunExecutor, type RunHost, type RunOutcome } from './run-executor.ts'
import { toJsonValue } from './shared/json.ts'

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
 * - 每次调度由 {@link RunExecutor} 驱动，节点在自身前驱全部结束后立即执行
 * - 支持暂停/恢复/取消，并把人工输入答案交给等待中的节点
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
  private readonly runHost: RunHost = {
    checkpoint: state => this.checkpoint(state),
    emit: (name, ...args) => { this.emitEvent(name, ...args) },
    log: (message) => { this.ctx.logger.info(message) },
  }

  constructor(ctx: Context, private readonly config: DagEngineConfig) {
    super(ctx)
    this.registry = ctx.workflowNodeRegistry
  }

  /**
   * 注册流程控制节点，打开定义与运行 Domain，启动恢复，并在服务卸载时停止运行、等待写入完成后关闭。
   *
   * 流程控制节点随引擎注册而不是随插件入口注册，因此任何加载了引擎的 Host 都能解析它们，
   * 包括恢复已保存的定义时。
   */
  protected async [Service.init](): Promise<void> {
    registerFlowControlNodes(this.ctx)
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
        releasePauseWaiters(state)
      }
      await Promise.all([...this.runs.values()].map(state => state.writeTail))
      await this.mutationTail
      await openedRuns.close()
      await domain.close()
    }, 'dagEngine.domainClose')
    this.workflows = domain.table('workflows')
    this.runStore = openedRuns.table('runs')
    this.recovered = this.recover()
    this.recovered.catch((error: unknown) => {
      this.ctx.logger.error(`dag: 运行恢复失败: ${messageOf(error)}`)
    })
  }

  async save(definition: DagWorkflowDefinition): Promise<WorkflowId> {
    const snapshot = structuredClone(definition)
    resolveExecutors(this.registry, snapshot)

    return this.enqueueMutation(async () => {
      const existing = this.findByName(snapshot.name)
      const id = existing !== undefined ? existing.id : this.allocateId(snapshot.name)
      await this.workflows.put(id, snapshot)
      return id
    })
  }

  /**
   * 替换一个已存在的定义；改名同时把记录换到新名称派生的 ID 下。
   *
   * 改名先写新记录再删旧记录，因此两次写入之间停机只会留下一份重复的旧记录，不会丢失定义。
   * 名称未改时保留原 ID，所以早于此规则保存的随机 ID 记录只在被改名时才换名。
   */
  async update(id: WorkflowId, definition: DagWorkflowDefinition): Promise<WorkflowId> {
    const snapshot = structuredClone(definition)
    resolveExecutors(this.registry, snapshot)
    return this.enqueueMutation(async () => {
      const current = this.workflows.get(id)
      if (current === undefined) {
        throw new Error(`工作流 "${id}" 不存在`)
      }
      const named = this.findByName(snapshot.name)
      if (named !== undefined && named.id !== id) {
        throw new Error(`工作流名称 "${snapshot.name}" 已存在`)
      }
      if (current.name === snapshot.name) {
        await this.workflows.put(id, snapshot)
        return id
      }
      const renamed = this.allocateId(snapshot.name)
      await this.workflows.put(renamed, snapshot)
      await this.workflows.delete(id)
      return renamed
    })
  }

  /**
   * 为一个尚未存储的名称分配记录键。
   * @param name - 工作流名称。
   * @returns 该名称派生的、未被占用的工作流 ID。
   */
  private allocateId(name: string): WorkflowId {
    return WorkflowId(uniqueWorkflowSlug(name, candidate => this.workflows.get(WorkflowId(candidate)) !== undefined))
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
    const executors = resolveExecutors(this.registry, definition)
    const runId = RunId(randomUUID())
    const now = Date.now()
    const state = createRunState({
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
    this.emitEvent('dag/start', runInfo(state))
    this.launch(state)
    return { runId, result: state.resultPromise }
  }

  getRun(runId: RunId): WorkflowRunRecord | undefined {
    const state = this.runs.get(runId)
    if (state !== undefined) return toRunRecord(state)
    const record = this.runStore.get(runId)
    return record === undefined ? undefined : structuredClone(record)
  }

  listRuns(): WorkflowRunSummary[] {
    const summaries = new Map<RunId, WorkflowRunSummary>()
    for (const [runId, record] of this.runStore.entries()) summaries.set(runId, summaryOfRecord(record))
    for (const state of this.runs.values()) summaries.set(state.runId, summaryOfRecord(toRunRecord(state)))
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
      this.emitEvent('dag/resumed', runInfo(state))
      this.checkpointInBackground(state)
      releasePauseWaiters(state)
      return
    }
    // 未执行的 paused/interrupted 运行：按当前注册表重新解析执行器后继续调度。
    state.executors = resolveExecutors(this.registry, state.definition)
    state.status = 'running'
    delete state.error
    this.emitEvent('dag/resumed', runInfo(state))
    this.launch(state)
  }

  cancelRun(runId: RunId, reason?: string): void {
    const state = this.liveState(runId)
    if (state === undefined) return
    const message = reason ?? 'cancelled'
    if (state.active) {
      state.abortController.abort(message)
      releasePauseWaiters(state)
      return
    }
    cancelRemaining(state, message)
    void this.finishRun(state, { status: 'cancelled', error: message })
  }

  /**
   * 未结束运行的内存状态。已结束运行（包括最终状态写入失败后留在内存中的运行）返回 undefined；未知运行抛出。
   * @param runId - 运行 ID。
   */
  private liveState(runId: RunId): RunState | undefined {
    const state = this.runs.get(runId)
    if (state !== undefined) return TERMINAL_STATUSES.has(state.status) ? undefined : state
    if (this.runStore.get(runId) !== undefined) return undefined
    throw new Error(`运行 ${runId} 不存在`)
  }

  // ---- 持久化与恢复 ----

  /**
   * 将运行的当前状态排队写入运行记录。引擎关闭后拒绝新的写入，使运行记录保持停止前的状态。
   * @returns 该次写入持久化后兑现；写入失败或引擎正在关闭时拒绝。
   */
  private checkpoint(state: RunState): Promise<void> {
    if (this.closing) return Promise.reject(new Error('工作流引擎正在关闭'))
    state.updatedAt = Date.now()
    const record = toRunRecord(state)
    const write = state.writeTail.then(() => this.runStore.put(state.runId, record))
    state.writeTail = write.catch((_error: unknown) => {
      // 失败已通过 `write` 交给调用方；队列只负责顺序。
    })
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
        state = createRunState(record)
      } catch (error: unknown) {
        const now = Date.now()
        await this.runStore.put(runId, {
          ...record, status: 'failed', error: `无法恢复: ${messageOf(error)}`, updatedAt: now, completedAt: now,
        })
        continue
      }
      const interrupted: NodeId[] = []
      for (const { record: nodeRecord } of state.nodeStates.values()) {
        if (nodeRecord.status !== 'running') continue
        interrupted.push(nodeRecord.nodeId)
        nodeRecord.status = 'pending'
        delete nodeRecord.outputs
        delete nodeRecord.fired
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
      executors = resolveExecutors(this.registry, state.definition)
    } catch (error: unknown) {
      this.interrupt(state, `无法恢复: ${messageOf(error)}`)
      return
    }
    const held = interrupted.filter((nodeId) => {
      const node = nodeState(state, nodeId).node
      return (node.recovery ?? executors.get(nodeId)?.recovery ?? 'rerun') === 'hold'
    })
    if (held.length > 0) {
      this.interrupt(state, `节点 ${held.join(', ')} 需要人工恢复后重新执行`)
      return
    }
    state.executors = executors
    state.status = 'running'
    this.emitEvent('dag/resumed', runInfo(state))
    this.launch(state)
  }

  private interrupt(state: RunState, reason: string): void {
    state.status = 'interrupted'
    state.error = reason
    this.checkpointInBackground(state)
    this.emitEvent('dag/interrupted', runInfo(state), reason)
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

  // ---- 外部结果 ----

  async signal(runId: RunId, nodeId: NodeId, requestId: string, result: unknown): Promise<void> {
    const state = this.liveState(runId)
    if (state === undefined) throw new Error(`运行 ${runId} 已结束`)
    const execState = state.nodeStates.get(nodeId)
    if (execState === undefined) throw new Error(`运行 ${runId} 没有节点 ${nodeId}`)
    const pending = execState.record.requests?.find(item => item.id === requestId)
    if (pending === undefined) throw new Error(`节点 ${nodeId} 没有请求 ${requestId}`)
    if (pending.result !== undefined) throw new Error(`请求 ${requestId} 已送达结果`)
    const validate = this.registry.get(execState.node.type)?.validateSignal
    const validated = toJsonValue(
      validate === undefined ? result : validate(pending.request, result),
      'result',
    )
    pending.result = validated
    pending.resolvedAt = Date.now()
    try {
      await this.checkpoint(state)
    } catch (error: unknown) {
      delete pending.result
      delete pending.resolvedAt
      throw error
    }
    this.emitEvent('dag/signal-received', runInfo(state), nodeId, requestId)
    state.signalWaiters.get(nodeId)?.get(requestId)?.(structuredClone(validated))
  }

  // ---- 调度 ----

  /** 开始调度运行中未结束的节点，并在结束后写入最终状态。 */
  private launch(state: RunState): void {
    state.active = true
    state.pauseRequested = false
    state.abortController = new AbortController()
    this.checkpoint(state)
      .then(() => new RunExecutor(state, this.runHost).execute())
      .catch((error: unknown): RunOutcome => ({ status: 'failed', error: messageOf(error) }))
      .then(outcome => this.finishRun(state, outcome))
      .catch((error: unknown) => {
        this.ctx.logger.error(`dag: 运行 ${state.runId} 结束处理失败: ${messageOf(error)}`)
      })
  }

  /**
   * 写入运行的最终状态并以运行记录兑现结果。引擎关闭时运行记录保持停止前的状态，下次启动时恢复；
   * 最终状态写入失败时运行留在内存中，使查询仍返回其最终状态。
   */
  private async finishRun(state: RunState, outcome: RunOutcome): Promise<void> {
    state.active = false
    state.status = outcome.status
    state.completedAt = Date.now()
    if (outcome.error !== undefined) state.error = outcome.error
    if (this.closing) {
      state.resultResolve(toRunRecord(state))
      return
    }
    this.emitEvent('dag/end', runInfo(state), { ...outcome })
    try {
      await this.checkpoint(state)
    } catch (error: unknown) {
      this.ctx.logger.error(`dag: 运行 ${state.runId} 最终状态写入失败: ${messageOf(error)}`)
      state.resultResolve(toRunRecord(state))
      return
    }
    this.runs.delete(state.runId)
    try {
      await this.enqueueMutation(() => this.pruneRuns())
    } finally {
      state.resultResolve(toRunRecord(state))
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
