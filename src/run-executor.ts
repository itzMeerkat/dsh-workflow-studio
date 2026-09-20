/**
 * 一个运行的调度循环：节点的前驱全部结束后即开始执行，处理暂停、外部结果等待和节点结果。
 * @module dsh-workflow-studio
 */

import type {
  DagNodeDefinition, JsonValue, NodeId, NodeExecutionContext, NodeExecutionResult, NodeRunInfo, NodeRunRecord,
  WorkflowNodeExecutor, WorkflowRunStatus,
} from './shared/types.ts'
import { toJsonObject, toJsonValue } from './shared/json.ts'
import { messageOf } from './shared/errors.ts'
import { execOutputPins, execSourcePin, inboundEdges, resolveInputPorts, type InboundEdges } from './shared/graph.ts'
import { isAnyJoin } from './flow-nodes.ts'
import { TERMINAL_NODE_STATUSES, cancelRemaining, nodeState, runInfo, type RunState } from './run-state.ts'

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
  | { status: 'completed'; outputs: Record<string, unknown>; fired: readonly string[] }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string; outputs?: Record<string, unknown> }

/** 一次节点调用。 */
interface NodeTask {
  node: DagNodeDefinition
  executor: WorkflowNodeExecutor
  record: NodeRunRecord
  info: NodeRunInfo
}

/** 执行一个运行中未结束的节点。每个节点的开始和结束状态都在写入运行记录后才继续。 */
export class RunExecutor {
  private readonly signal: AbortSignal
  /** 本次运行定义的入边索引；定义在运行期间不变，因此只建一次。 */
  private readonly inbound: InboundEdges

  /**
   * @param state - 已设置执行器和新的 AbortController 的运行状态。
   * @param host - 引擎能力。
   */
  constructor(private readonly state: RunState, private readonly host: RunHost) {
    this.signal = state.abortController.signal
    this.inbound = inboundEdges(state.definition.edges)
  }

  /**
   * 调度所有 pending 节点直到运行结束、失败或被取消。
   *
   * 节点在自己的全部前驱结束后立即开始，而不等待同层的其他节点，因此一个长节点不会拖住与它无关的分支。
   * 节点失败后不再启动新节点，已在执行的节点跑完后运行才失败，使带副作用的节点不被半途丢下。
   * @returns 运行的结束状态；节点失败或写入失败时为 failed。
   */
  async execute(): Promise<RunOutcome> {
    const { state, signal } = this
    try {
      const waiting = new Set(state.definition.nodes
        .filter(node => nodeState(state, node.id).record.status === 'pending')
        .map(node => node.id))
      const running = new Map<NodeId, Promise<NodeId>>()
      let failure: string | undefined

      while (true) {
        // A paused run has nothing running, so it first waits for the nodes already started to settle.
        if (!signal.aborted && failure === undefined && running.size === 0) await this.checkPause()
        // Cancelling, a failure, and a pause all stop new nodes from starting; none abandons a started one.
        const halted = signal.aborted || failure !== undefined || state.pauseRequested

        let started = false
        let skipped = false
        if (!halted) {
          for (const id of [...waiting]) {
            if (!this.ready(id)) continue
            waiting.delete(id)
            started = true
            const { node } = nodeState(state, id)
            if (this.gateSkipped(node)) skipped = true
            else running.set(id, this.runTracked(node))
          }
        }
        if (skipped) await this.host.checkpoint(state)

        if (running.size > 0) {
          const settled = await Promise.race(running.values())
          running.delete(settled)
          const record = nodeState(state, settled).record
          if (record.status === 'failed') {
            failure ??= `${record.nodeId}: ${record.error ?? '节点执行失败'}`
          }
          continue
        }
        if (signal.aborted || failure !== undefined || waiting.size === 0) break
        // Nothing ran and nothing is running, so a predecessor of every remaining node never settles.
        if (!started) throw new Error(`工作流无法继续，以下节点的前驱永不结束：${[...waiting].join(', ')}`)
      }

      if (failure !== undefined) {
        cancelRemaining(state, failure)
        return { status: 'failed', error: failure }
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
   * 节点的全部前驱是否都已结束。
   *
   * 数据边和执行边同样计入：前者的值要先产生，后者是作者声明的顺序。等待外部结果的节点仍为 running，
   * 因此它的下游继续等待。
   * @param id - 待执行节点的 ID。
   */
  private ready(id: NodeId): boolean {
    const settled = (source: NodeId): boolean =>
      TERMINAL_NODE_STATUSES.has(nodeState(this.state, source).record.status)
    return (this.inbound.data.get(id) ?? []).every(edge => settled(edge.source))
      && (this.inbound.exec.get(id) ?? []).every(edge => settled(edge.source))
  }

  /**
   * 执行一个节点，并把调度器自身的缺陷转为该节点的失败。
   * @param node - 待执行的节点。
   * @returns 节点结束后兑现为它的 ID；永不 reject，否则等待中的其他节点会被丢下。
   */
  private async runTracked(node: DagNodeDefinition): Promise<NodeId> {
    try {
      await this.executeNode(node)
    } catch (error: unknown) {
      const record = nodeState(this.state, node.id).record
      record.status = 'failed'
      record.error = messageOf(error)
      record.completedAt = Date.now()
    }
    return node.id
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

  /** 在没有节点执行时响应暂停请求，直到运行恢复或取消。 */
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

  /**
   * 按执行边决定节点是否被跳过，跳过时就地结束其记录。
   *
   * 源节点未完成或未触发该引脚时执行边失效。普通节点是 AND 连接，任一入边失效即跳过；
   * OR 连接点（{@link isAnyJoin}）只在全部入边失效时跳过。跳过的节点不触发任何引脚，
   * 因此跳过沿执行边传递。
   * @param node - 前驱已全部结束、待执行的节点。
   * @returns 节点因执行边失效而跳过时为 true。
   */
  private gateSkipped(node: DagNodeDefinition): boolean {
    const inbound = this.inbound.exec.get(node.id) ?? []
    if (inbound.length === 0) return false
    const live = inbound.filter((edge) => {
      const source = nodeState(this.state, edge.source).record
      return source.status === 'completed' && (source.fired ?? []).includes(execSourcePin(edge))
    })
    const dead = isAnyJoin(this.executorFor(node))
      ? live.length === 0
      : live.length < inbound.length
    if (!dead) return false
    const record = nodeState(this.state, node.id).record
    record.status = 'skipped'
    record.startedAt = Date.now()
    record.completedAt = record.startedAt
    this.host.emit('dag/node-end', runInfo(this.state), {
      nodeId: node.id,
      nodeType: node.type,
      label: node.label ?? node.type,
      status: 'skipped',
    })
    return true
  }

  /**
   * 运行状态中该节点的执行器。
   * @param node - 定义中的节点。
   * @throws 运行状态缺少该节点的执行器时；执行器由 `resolveExecutors` 为每个节点填充，缺失即为缺陷。
   */
  private executorFor(node: DagNodeDefinition): WorkflowNodeExecutor {
    const executor = this.state.executors.get(node.id)
    if (executor === undefined) throw new Error(`运行状态缺少节点 ${node.id} 的执行器`)
    return executor
  }

  private async executeNode(node: DagNodeDefinition): Promise<void> {
    if (this.signal.aborted) return
    const executor = this.executorFor(node)
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

  /** 通过输入检查后调用执行器。 */
  private async runNode(task: NodeTask, inputs: Record<string, unknown>): Promise<NodeEnd> {
    const { node, executor } = task
    const context = this.nodeContext(task, inputs)

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
      connected: new Set((this.inbound.data.get(node.id) ?? []).map(edge => edge.targetPort ?? 'input')),
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
   * 检查必需输入端口都已送达。
   *
   * 节点被调用时，其必需输入按定义就应存在；缺失意味着工作流接线有误或上游未兑现输出，两者都是错误。
   * 跳过只由失效的执行边产生，不由缺少数据产生。
   * @param node - 待执行的节点。
   * @param executor - 该节点的执行器。
   * @param inputs - 已收集到的输入端口数据。
   * @returns 缺少必需输入时为 failed；可执行时为 undefined。
   */
  private inputGate(
    node: DagNodeDefinition,
    executor: WorkflowNodeExecutor,
    inputs: Record<string, unknown>,
  ): NodeEnd | undefined {
    const inputPorts = resolveInputPorts(node.inputs, executor.inputs ?? [])
    const missing = inputPorts
      .filter(port => port.required !== false && !Object.hasOwn(inputs, port.name))
      .map((port) => {
        const edge = (this.inbound.data.get(node.id) ?? [])
          .find(item => (item.targetPort ?? 'input') === port.name)
        return edge === undefined ? port.name : `${port.name}（应由 ${edge.source} 产生）`
      })
    if (missing.length === 0) return undefined
    return { status: 'failed', error: `缺少输入端口: ${missing.join(', ')}` }
  }

  /** 收集上游输出到当前节点的输入端口。 */
  private collectInputs(node: DagNodeDefinition): Record<string, unknown> {
    const inputs: Record<string, unknown> = {}
    for (const edge of this.inbound.data.get(node.id) ?? []) {
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
    if (end.status === 'completed') record.fired = [...end.fired]
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
      const declared = (node.outputs ?? executor.outputs ?? []).map(port => port.name)
      const undeclared = Object.keys(result.outputs).find(name => !declared.includes(name))
      if (undeclared !== undefined) return { status: 'failed', error: `节点 ${node.id} 返回未声明的输出端口 ${undeclared}` }
      const unproduced = declared.filter(name => result.outputs[name] === undefined)
      if (unproduced.length > 0) {
        return { status: 'failed', error: `节点 ${node.id} 完成时未产生输出端口 ${unproduced.join(', ')}；无内容时写 null` }
      }
      const pins = execOutputPins(executor)
      const fired = result.next ?? pins
      const unknown = fired.find(pin => !pins.includes(pin))
      if (unknown !== undefined) {
        return { status: 'failed', error: `节点 ${node.id} 触发未声明的执行输出引脚 ${unknown}` }
      }
      try {
        return { status: 'completed', outputs: toJsonObject(result.outputs, label), fired: [...fired] }
      } catch (error: unknown) {
        return { status: 'failed', error: messageOf(error) }
      }
    }
    case 'failed': {
      if (result.outputs === undefined) return { status: 'failed', error: result.error }
      try {
        return { status: 'failed', error: result.error, outputs: toJsonObject(result.outputs, label) }
      } catch (error: unknown) {
        return { status: 'failed', error: `${result.error}（诊断输出已丢弃: ${messageOf(error)}）` }
      }
    }
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
