/**
 * DAG 引擎默认实现。
 *
 * 包含拓扑排序（Kahn）、层级执行、暂停恢复和 HITL 集成。
 * @module dsh-workflow-studio
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import DagEngine from './engine.ts'
import type { DagRun } from './engine.ts'
import type {
  DagWorkflowDefinition, DagNodeDefinition, DagEdgeDefinition,
  NodeId,
  WorkflowResult, WorkflowSummary,
  NodeExecutionContext, NodeExecutionResult,
  NodeRunRecord, NodeRunStatus, PortDefinition,
  WorkflowRunStatus, NodeRunInfo, DagRunInfo,
  WorkflowNodeExecutor,
} from './types.ts'
import { WorkflowId, RunId } from './types.ts'
import { CONDITION_PORT } from './registry.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import { workflowStudioDomainSpec } from './persistence.ts'
import { workflowDefinitionSchema } from './workflow-schema.ts'

// ---- 内部状态 ----

interface NodeExecState {
  node: DagNodeDefinition
  record: NodeRunRecord
}

interface RunState {
  runId: RunId
  workflowId: WorkflowId
  definition: DagWorkflowDefinition
  executors: Map<NodeId, WorkflowNodeExecutor>
  status: WorkflowRunStatus
  nodeStates: Map<NodeId, NodeExecState>
  startedAt: number
  completedAt?: number
  error?: string
  abortController: AbortController
  pauseRequested: boolean
  pauseResolvers: Set<() => void>
  resultPromise: Promise<WorkflowResult>
  resultResolve: (result: WorkflowResult) => void
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
export class DagEngineProvider extends DagEngine {
  static inject = ['workflowNodeRegistry', 'storageDomain']

  private workflows!: KvTable<WorkflowId, DagWorkflowDefinition>
  private readonly runs = new Map<RunId, RunState>()
  private readonly registry: WorkflowNodeRegistry
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(ctx: import('@deepseek-ai/cordis').Context) {
    super(ctx)
    this.registry = ctx.workflowNodeRegistry
  }

  /** 打开工作流 Domain，并在服务卸载时等待所有写入完成后关闭。 */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workflowStudioDomainSpec)
    this.ctx.effect(() => async () => {
      await this.mutationTail
      await domain.close()
    }, 'dagEngine.domainClose')
    this.workflows = domain.table('workflows')
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
    const inputs = node.inputs ?? executor.inputs ?? []
    if (executor.acceptsCondition === false) return inputs
    if (inputs.some(port => port.name === CONDITION_PORT.name)) {
      throw new Error(`节点 ${node.id} 的输入端口 condition 由引擎保留`)
    }
    return [...inputs, CONDITION_PORT]
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
    const definition = this.get(workflowId)
    if (definition === undefined) throw new Error(`工作流 ${workflowId} 未找到`)
    const executors = new Map<NodeId, WorkflowNodeExecutor>()
    for (const node of definition.nodes) {
      const executor = this.registry.get(node.type)
      if (executor === undefined) throw new Error(`节点类型 ${node.type} 已卸载，无法启动工作流`)
      executors.set(node.id, executor)
    }

    const runId = RunId(randomUUID())
    const abortController = new AbortController()
    const runInfo: DagRunInfo = {
      runId,
      workflowId,
      name: definition.name,
      status: 'running',
    }

    const { promise: resultPromise, resolve: resultResolve } = Promise.withResolvers<WorkflowResult>()

    const runState: RunState = {
      runId,
      workflowId,
      definition,
      executors,
      status: 'running',
      nodeStates: new Map(),
      startedAt: Date.now(),
      abortController,
      pauseRequested: false,
      pauseResolvers: new Set(),
      resultPromise,
      resultResolve,
    }

    this.runs.set(runId, runState)
    this.emitEvent('dag/start', runInfo)

    // 异步执行
    this.executeWorkflow(runState, definition).then(
      (result) => { this.finishRun(runState, result) },
      (error: unknown) => {
        this.finishRun(runState, {
          runId,
          status: 'failed',
          error: String(error),
          nodeRecords: [],
          startedAt: runState.startedAt,
          completedAt: Date.now(),
        })
      },
    )

    const dagMeta: { name: string; description?: string } = { name: definition.name }
    if (definition.description !== undefined) dagMeta.description = definition.description
    return {
      runId,
      meta: dagMeta,
      result: runState.resultPromise,
      pause: () => { this.pauseRun(runState) },
      resume: () => { this.resumeRun(runState) },
      cancel: (reason?: string) => { this.cancelRun(runState, reason) },
      dispose: async () => {
        this.cancelRun(runState, 'dispose')
        await runState.resultPromise
      },
    }
  }

  getRun(runId: RunId): WorkflowResult | undefined {
    const state = this.runs.get(runId)
    if (state === undefined) return undefined
    const result: WorkflowResult = {
      runId,
      status: state.status,
      nodeRecords: structuredClone([...state.nodeStates.values()].map(s => s.record)),
      startedAt: state.startedAt,
    }
    if (state.completedAt !== undefined) result.completedAt = state.completedAt
    if (state.error !== undefined) result.error = state.error
    return result
  }

  // ---- 暂停/恢复 ----

  private pauseRun(state: RunState): void {
    if (state.status !== 'running') return
    state.pauseRequested = true
  }

  private resumeRun(state: RunState): void {
    state.pauseRequested = false
    if (state.status !== 'paused') return
    state.status = 'running'
    this.emitEvent('dag/resumed', this.runInfo(state))
    this.releasePauseWaiters(state)
  }

  private cancelRun(state: RunState, reason?: string): void {
    if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed') return
    state.abortController.abort(reason ?? 'cancelled')
    this.releasePauseWaiters(state)
  }

  private finishRun(state: RunState, result: WorkflowResult): void {
    state.status = result.status
    state.completedAt = result.completedAt ?? Date.now()
    if (result.error !== undefined) state.error = result.error
    this.emitEvent('dag/end', this.runInfo(state), {
      status: result.status,
      ...(result.error === undefined ? {} : { error: result.error }),
    })
    state.resultResolve(structuredClone(result))
  }

  // ---- 执行引擎 ----

  private async executeWorkflow(
    state: RunState,
    definition: DagWorkflowDefinition,
  ): Promise<WorkflowResult> {
    const levels = topologicalSort(definition)
    const signal = state.abortController.signal

    // 初始化节点状态
    for (const node of definition.nodes) {
      state.nodeStates.set(node.id, {
        node,
        record: {
          nodeId: node.id,
          status: 'pending',
          startedAt: 0,
          runId: state.runId,
        },
      })
    }

    try {
      for (const level of levels) {
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
        const tasks = level.nodes.map(node =>
          this.executeNode(state, node, signal, definition),
        )
        await Promise.all(tasks)
        const failed = level.nodes
          .map(node => this.nodeState(state, node.id).record)
          .filter(record => record.status === 'failed')
        if (failed.length > 0) {
          const error = failed.map(record => `${record.nodeId}: ${record.error ?? '节点执行失败'}`).join('; ')
          this.cancelRemaining(state, error)
          return this.workflowResult(state, 'failed', error)
        }
      }

      // 处理暂停后恢复时的取消
      if (signal.aborted) {
        this.cancelRemaining(state, signal.reason)
      }

      const finalStatus: WorkflowRunStatus = signal.aborted ? 'cancelled' : 'completed'
      return this.workflowResult(
        state,
        finalStatus,
        signal.aborted && signal.reason !== undefined ? String(signal.reason) : undefined,
      )
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.cancelRemaining(state, message)
      return this.workflowResult(state, 'failed', message)
    }
  }

  private async executeNode(
    state: RunState,
    node: DagNodeDefinition,
    signal: AbortSignal,
    definition: DagWorkflowDefinition,
  ): Promise<void> {
    if (signal.aborted) return
    const execState = this.nodeState(state, node.id)
    const executor = this.executor(state, node.id)

    // 收集上游输入
    const inputs = this.collectInputs(node, definition, state)
    const inputPorts = this.resolveInputPorts(node, executor)
    const businessInputPorts = inputPorts.filter(port => port.role !== 'condition')
    const suppliedInputs = businessInputPorts.filter(port => Object.hasOwn(inputs, port.name))
    const conditionEdge = definition.edges.find(edge =>
      edge.target === node.id && (edge.targetPort ?? 'input') === CONDITION_PORT.name)
    const requiredInputPorts = inputPorts.filter(port => port.required !== false)
    const startedAt = Date.now()
    execState.record.startedAt = startedAt
    execState.record.inputs = structuredClone(inputs)

    const nodeInfo: NodeRunInfo = {
      nodeId: node.id,
      nodeType: node.type,
      label: node.label ?? node.type,
      status: 'running',
    }
    execState.record.status = 'running'
    this.emitEvent('dag/node-start', this.runInfo(state), nodeInfo)

    if (conditionEdge !== undefined) {
      if (!Object.hasOwn(inputs, CONDITION_PORT.name) || inputs.condition === false) {
        this.completeNode(state, execState, nodeInfo, 'skipped', {})
        return
      }
      if (inputs.condition !== true) {
        this.failNode(state, execState, nodeInfo, 'condition 输入必须为布尔值')
        return
      }
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

    // HITL
    if (executor.requiresHumanInput === true || node.requiresHumanInput === true) {
      await this.handleHumanInTheLoop(state, execState, node)
      if (signal.aborted) {
        this.completeNode(state, execState, nodeInfo, 'cancelled')
        return
      }
    }

    try {
      const context: NodeExecutionContext = {
        runId: state.runId,
        config: node.config,
        inputs: executor.acceptsCondition === false
          ? inputs
          : Object.fromEntries(
            Object.entries(inputs).filter(([name]) => name !== CONDITION_PORT.name),
          ),
        signal,
        log: (msg: string) => {
          this.ctx.logger.info(`[${state.definition.name}/${node.label ?? node.type}] ${msg}`)
        },
      }

      const result = await executor.execute(context)
      if (signal.aborted) {
        this.completeNode(state, execState, nodeInfo, 'cancelled')
      } else if (result.status === 'failed') {
        this.failNode(state, execState, nodeInfo, result.error, result.outputs)
      } else {
        this.validateOutputs(node, executor, result)
        this.completeNode(state, execState, nodeInfo, 'completed', result.outputs)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.failNode(state, execState, nodeInfo, message)
    }
  }

  /** 收集上游输出到当前节点的输入端口。 */
  private collectInputs(
    node: DagNodeDefinition,
    definition: DagWorkflowDefinition,
    state: RunState,
  ): Record<string, unknown> {
    const incomingEdges = definition.edges.filter(e => e.target === node.id)
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

  private async checkPause(state: RunState): Promise<void> {
    if (!state.pauseRequested || state.status !== 'running') return
    const resumed = this.waitForResume(state)
    state.status = 'paused'
    this.emitEvent('dag/paused', this.runInfo(state))
    await resumed
  }

  private async handleHumanInTheLoop(
    state: RunState,
    execState: NodeExecState,
    node: DagNodeDefinition,
  ): Promise<void> {
    this.ctx.logger.info(`[workflow] 节点 ${node.label ?? node.type} 需要人工确认，暂停等待`)
    const resumed = this.waitForResume(state)
    state.status = 'paused'
    execState.record.status = 'paused'
    this.emitEvent('dag/paused', this.runInfo(state))

    try {
      await resumed
    } finally {
      if (!state.abortController.signal.aborted) execState.record.status = 'running'
    }
  }

  private waitForResume(state: RunState): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    state.pauseResolvers.add(resolve)
    return promise.finally(() => {
      state.pauseResolvers.delete(resolve)
    })
  }

  private releasePauseWaiters(state: RunState): void {
    for (const resolve of state.pauseResolvers) resolve()
    state.pauseResolvers.clear()
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

  private workflowResult(
    state: RunState,
    status: WorkflowRunStatus,
    error?: string,
  ): WorkflowResult {
    return {
      runId: state.runId,
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
