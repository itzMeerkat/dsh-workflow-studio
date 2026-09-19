/**
 * 一个运行的调度循环：按拓扑层级执行节点，处理暂停、外部结果等待和节点结果。
 * @module dsh-workflow-studio
 */

import type {
  DagNodeDefinition, JsonValue, NodeExecutionContext, NodeExecutionResult, NodeRunInfo, NodeRunRecord,
  WorkflowNodeExecutor, WorkflowRunStatus,
} from './shared/types.ts'
import { toJsonOutputs, toJsonValue } from './shared/json.ts'
import { messageOf } from './shared/errors.ts'
import { resolveInputPorts } from './shared/graph.ts'
import { topologicalSort } from './validation.ts'
import { cancelRemaining, nodeState, runInfo, type RunState } from './run-state.ts'

/** 一次调度结束时的运行状态与原因。 */
export interface RunOutcome {
  status: WorkflowRunStatus
  error?: string
}

/** 调度循环使用的引擎能力。 */
export interface RunHost {
  /**
   * 将运行的当前状态写入运行记录。
   * @returns 写入持久化后兑现；失败或引擎关闭时拒绝。
   */
  checkpoint(state: RunState): Promise<void>
  /** 派发引擎事件；监听器错误不传给调用方。 */
  emit(name: string, ...args: unknown[]): void
  /** 记录节点日志。 */
  log(message: string): void
}

/** 节点的结束状态及写入其记录的输出和错误。 */
type NodeEnd =
  | { status: 'completed' | 'skipped'; outputs: Record<string, unknown> }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string; outputs?: Record<string, unknown> }

/** 一次节点调用。 */
interface NodeTask {
  node: DagNodeDefinition
  executor: WorkflowNodeExecutor
  record: NodeRunRecord
  info: NodeRunInfo
}

const SKIPPED: NodeEnd = { status: 'skipped', outputs: {} }

/** 执行一个运行中未结束的节点。每个节点的开始和结束状态都在写入运行记录后才继续。 */
export class RunExecutor {
  private readonly signal: AbortSignal

  /**
   * @param state - 已设置执行器和新的 AbortController 的运行状态。
   * @param host - 引擎能力。
   */
  constructor(private readonly state: RunState, private readonly host: RunHost) {
    this.signal = state.abortController.signal
  }

  /**
   * 调度所有 pending 节点直到运行结束、失败或被取消。
   * @returns 运行的结束状态；节点失败或写入失败时为 failed。
   */
  async execute(): Promise<RunOutcome> {
    const { state, signal } = this
    try {
      for (const level of topologicalSort(state.definition)) {
        const pending = level.filter(node => nodeState(state, node.id).record.status === 'pending')
        if (pending.length === 0) continue
        if (!signal.aborted) await this.checkPause()
        if (signal.aborted) break

        await Promise.all(pending.map(node => this.executeNode(node)))
        const failed = pending
          .map(node => nodeState(state, node.id).record)
          .filter(record => record.status === 'failed')
        if (failed.length > 0) {
          const error = failed.map(record => `${record.nodeId}: ${record.error ?? '节点执行失败'}`).join('; ')
          cancelRemaining(state, error)
          return { status: 'failed', error }
        }
      }

      if (!signal.aborted) return { status: 'completed' }
      cancelRemaining(state, signal.reason)
      return signal.reason === undefined ? { status: 'cancelled' } : { status: 'cancelled', error: String(signal.reason) }
    } catch (error: unknown) {
      const message = messageOf(error)
      cancelRemaining(state, message)
      return { status: 'failed', error: message }
    }
  }

  /**
   * 声明或复用节点的外部结果等待。节点保持 running；已送达结果的请求立即返回。
   * @returns 送达的结果；运行取消时以中止原因拒绝。
   */
  private async awaitSignal(task: NodeTask, requestId: string, request: unknown): Promise<JsonValue> {
    if (requestId.trim() === '') throw new TypeError('requestId 必须为非空字符串')
    const { record } = task
    record.requests ??= []
    let pending = record.requests.find(item => item.id === requestId)
    if (pending?.result !== undefined) return structuredClone(pending.result)
    this.signal.throwIfAborted()
    if (pending === undefined) {
      pending = { id: requestId, request: toJsonValue(request, 'request'), createdAt: Date.now() }
      record.requests.push(pending)
    }
    const waiters = this.state.signalWaiters.get(record.nodeId) ?? new Map<string, (result: JsonValue) => void>()
    this.state.signalWaiters.set(record.nodeId, waiters)
    const { promise, resolve } = Promise.withResolvers<JsonValue>()
    waiters.set(requestId, resolve)
    try {
      await this.host.checkpoint(this.state)
      this.host.emit('dag/signal-requested', runInfo(this.state), task.info, requestId)
      return await abortable(promise, this.signal)
    } finally {
      waiters.delete(requestId)
    }
  }

  /** 在层级之间响应暂停请求，直到运行恢复或取消。 */
  private async checkPause(): Promise<void> {
    const { state } = this
    if (!state.pauseRequested || state.status !== 'running') return
    const { promise, resolve } = Promise.withResolvers<void>()
    state.pauseResolvers.add(resolve)
    state.status = 'paused'
    this.host.emit('dag/paused', runInfo(state))
    try {
      await this.host.checkpoint(state)
      await promise
    } finally {
      state.pauseResolvers.delete(resolve)
    }
  }

  private async executeNode(node: DagNodeDefinition): Promise<void> {
    if (this.signal.aborted) return
    const executor = this.state.executors.get(node.id)
    if (executor === undefined) throw new Error(`运行状态缺少节点 ${node.id} 的执行器`)
    const record = nodeState(this.state, node.id).record
    const inputs = this.collectInputs(node)
    record.attempts += 1
    record.status = 'running'
    record.startedAt = Date.now()
    record.inputs = structuredClone(inputs)
    const task: NodeTask = {
      node,
      executor,
      record,
      info: { nodeId: node.id, nodeType: node.type, label: node.label ?? node.type, status: 'running' },
    }
    this.host.emit('dag/node-start', runInfo(this.state), task.info)
    await this.host.checkpoint(this.state)
    this.endNode(task, await this.runNode(task, inputs))
    await this.host.checkpoint(this.state)
  }

  /** 依次经过 preflight 和输入检查后调用执行器。 */
  private async runNode(task: NodeTask, inputs: Record<string, unknown>): Promise<NodeEnd> {
    const { node, executor } = task
    const context = this.nodeContext(task, inputs)

    let preflight: NodeExecutionResult | undefined
    try {
      preflight = executor.preflight?.(context)
    } catch (error: unknown) {
      return { status: 'failed', error: messageOf(error) }
    }
    if (preflight !== undefined) return resultEnd(node, executor, preflight)

    const gate = this.inputGate(node, executor, inputs)
    if (gate !== undefined) return gate

    try {
      const result = await executor.execute(context)
      return this.signal.aborted ? { status: 'cancelled' } : resultEnd(node, executor, result)
    } catch (error: unknown) {
      return this.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: messageOf(error) }
    }
  }

  private nodeContext(task: NodeTask, inputs: Record<string, unknown>): NodeExecutionContext {
    const { state, host } = this
    const { node, record } = task
    return {
      runId: state.runId,
      config: node.config,
      inputs,
      connected: new Set(state.definition.edges
        .filter(edge => edge.target === node.id)
        .map(edge => edge.targetPort ?? 'input')),
      invocationKey: `${state.runId}/${node.id}`,
      notepad: {
        get value() {
          return record.notepad === undefined ? undefined : structuredClone(record.notepad)
        },
        save: async (value) => {
          record.notepad = toJsonValue(value, 'notepad')
          await host.checkpoint(state)
        },
      },
      awaitSignal: async (requestId, request) => this.awaitSignal(task, requestId, request),
      signal: this.signal,
      log: (message: string) => {
        host.log(`[${state.definition.name}/${node.label ?? node.type}] ${message}`)
      },
    }
  }

  /**
   * 按必需输入端口的提供情况决定节点是否执行。
   * @returns 未提供任何业务输入或缺失输入的上游被跳过时为 skipped，其余缺失为 failed；可执行时为 undefined。
   */
  private inputGate(
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    inputs: Record<string, unknown>,
  ): NodeEnd | undefined {
    const inputPorts = resolveInputPorts(node.inputs, executor.inputs ?? [])
    const required = inputPorts.filter(port => port.required !== false)
    if (required.length === 0) return undefined
    const supplied = inputPorts.some(port => port.role === undefined && Object.hasOwn(inputs, port.name))
    if (!supplied) return SKIPPED
    const missing = required.filter(port => !Object.hasOwn(inputs, port.name)).map(port => port.name)
    if (missing.length === 0) return undefined
    const skippedDependency = this.state.definition.edges.some(edge =>
      edge.target === node.id
      && missing.includes(edge.targetPort ?? 'input')
      && nodeState(this.state, edge.source).record.status === 'skipped')
    return skippedDependency ? SKIPPED : { status: 'failed', error: `缺少输入端口: ${missing.join(', ')}` }
  }

  /** 收集上游输出到当前节点的输入端口。 */
  private collectInputs(node: DagNodeDefinition): Record<string, unknown> {
    const inputs: Record<string, unknown> = {}
    for (const edge of this.state.definition.edges) {
      if (edge.target !== node.id) continue
      const outputs = nodeState(this.state, edge.source).record.outputs
      const sourcePort = edge.sourcePort ?? 'output'
      if (outputs !== undefined && Object.hasOwn(outputs, sourcePort)) {
        inputs[edge.targetPort ?? 'input'] = outputs[sourcePort]
      }
    }
    return inputs
  }

  private endNode({ record, info }: NodeTask, end: NodeEnd): void {
    record.status = end.status
    if (end.status === 'failed') record.error = end.error
    if (end.status === 'cancelled' && this.signal.reason !== undefined) record.error = String(this.signal.reason)
    if ('outputs' in end && end.outputs !== undefined) record.outputs = structuredClone(end.outputs)
    record.completedAt = Date.now()
    this.host.emit('dag/node-end', runInfo(this.state), { ...info, status: end.status })
  }
}

/** 节点返回结果对应的结束状态；completed 的输出须为已声明端口的 JSON 值。 */
function resultEnd(node: DagNodeDefinition, executor: WorkflowNodeExecutor, result: NodeExecutionResult): NodeEnd {
  const label = `节点 ${node.id} 的输出`
  switch (result.status) {
    case 'completed': {
      const declared = new Set((node.outputs ?? executor.outputs ?? []).map(port => port.name))
      const undeclared = Object.keys(result.outputs).find(name => !declared.has(name))
      if (undeclared !== undefined) return { status: 'failed', error: `节点 ${node.id} 返回未声明的输出端口 ${undeclared}` }
      try {
        return { status: 'completed', outputs: toJsonOutputs(result.outputs, label) }
      } catch (error: unknown) {
        return { status: 'failed', error: messageOf(error) }
      }
    }
    case 'failed': {
      if (result.outputs === undefined) return { status: 'failed', error: result.error }
      try {
        return { status: 'failed', error: result.error, outputs: toJsonOutputs(result.outputs, label) }
      } catch (error: unknown) {
        return { status: 'failed', error: `${result.error}（诊断输出已丢弃: ${messageOf(error)}）` }
      }
    }
    case 'skipped':
      return SKIPPED
    default:
      return assertNever(result)
  }
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
