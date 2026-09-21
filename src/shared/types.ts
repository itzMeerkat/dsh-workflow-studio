/**
 * dsh-workflow-studio 核心类型定义。
 *
 * 定义 DAG 工作流的节点/边/运行期类型，以及节点插件和引擎接口。
 * @module dsh-workflow-studio
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

// ---- Branded IDs ----

/** 工作流定义 ID，由工作流名称派生，同时是它的记录文件名。 */
export type WorkflowId = Branded<'WorkflowId'>
export function WorkflowId(id: string): WorkflowId { return id as WorkflowId }

/** 工作流运行时运行 ID。每次执行唯一，用于幂等。 */
export type RunId = Branded<'RunId'>
export function RunId(id: string): RunId { return id as RunId }

/** DAG 节点 ID。 */
export type NodeId = Branded<'NodeId'>
export function NodeId(id: string): NodeId { return id as NodeId }

/** DAG 边 ID。 */
export type EdgeId = Branded<'EdgeId'>
export function EdgeId(id: string): EdgeId { return id as EdgeId }

// ---- JSON 值 ----

/** 可无损写入 JSON 持久化记录的值。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

/** 键为字符串的 JSON 对象。 */
export interface JsonObject {
  [key: string]: JsonValue
}

// ---- 工作流定义 ----

/**
 * 运行因 Host 停止而中断后，节点如何恢复。
 * - `rerun`：自动重新调用节点（至少一次语义）。
 * - `hold`：运行进入 interrupted，等待人工恢复后再重新调用。
 */
export type NodeRecoveryPolicy = 'rerun' | 'hold'

/** 端口类型约束（仅文档用途，运行时不检查）。 */
export type PortType = 'number' | 'string' | 'boolean' | 'any'

/** 端口描述。 */
export interface PortDefinition {
  name: string
  type: PortType
  description?: string
  /** 输入端口是否必须连接；省略时为 true。输出端口始终产生值，该字段对其无意义。 */
  required?: boolean
  /** 在节点卡片中展示输出值的方式。 */
  display?: 'value' | 'json'
}

/** 节点卡片中编辑 config 字段的控件定义。 */
export type NodeControlDefinition =
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'number'
    readonly defaultValue: number
    readonly min?: number
    readonly max?: number
    readonly step?: number
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'text'
    readonly defaultValue: string
    readonly placeholder?: string
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'boolean'
    readonly defaultValue: boolean
  }
  | {
    readonly name: string
    readonly label: string
    readonly kind: 'select'
    readonly defaultValue: string
    readonly options: readonly {
      readonly label: string
      readonly value: string
    }[]
  }

/** DAG 节点定义。 */
export interface DagNodeDefinition {
  id: NodeId
  /** 节点类型名，与注册的 {@link WorkflowNodeExecutor.type} 匹配。 */
  type: string
  label?: string
  config: Record<string, unknown>
  /** 覆盖执行器声明的中断恢复策略。 */
  recovery?: NodeRecoveryPolicy
  /** 可视化编辑器中的节点坐标。 */
  position?: { x: number; y: number }
  /** 节点声明的输出端口；省略时使用执行器声明。 */
  outputs?: PortDefinition[]
  /** 节点声明的输入端口；省略时使用执行器声明。 */
  inputs?: PortDefinition[]
}

/** DAG 边的公共字段。 */
interface DagEdgeBase {
  id: EdgeId
  source: NodeId
  target: NodeId
}

/** 把上游输出端口的值送到下游输入端口的数据边。 */
export interface DagDataEdge extends DagEdgeBase {
  kind: 'data'
  /** 源节点输出端口（默认 "output"）。 */
  sourcePort?: string
  /** 目标节点输入端口（默认 "input"）。 */
  targetPort?: string
}

/**
 * 控制执行顺序的执行边：目标节点在源节点完成后才执行。
 *
 * 源节点未完成时该边失效，目标节点不被调用而直接 skipped。数据边不传递这一语义。
 */
export interface DagExecEdge extends DagEdgeBase {
  kind: 'exec'
  /** 源节点执行输出引脚（默认 {@link EXEC_THEN_PIN}）。 */
  sourcePort?: string
  /** 目标节点执行输入引脚（默认 {@link EXEC_RUN_PIN}）。 */
  targetPort?: string
}

/** DAG 边定义。 */
export type DagEdgeDefinition = DagDataEdge | DagExecEdge

/** 可 JSON 导入导出的完整工作流定义。 */
export interface DagWorkflowDefinition {
  name: string
  description?: string
  nodes: DagNodeDefinition[]
  edges: DagEdgeDefinition[]
  inputs?: PortDefinition[]
  outputs?: PortDefinition[]
}

/** 工作流摘要（列表用）。 */
export interface WorkflowSummary {
  id: WorkflowId
  name: string
  description?: string
}

// ---- 运行期类型 ----

/** 节点执行上下文，由引擎在每次调用节点 execute() 时传入。 */
export interface NodeExecutionContext {
  /** 本次运行的唯一 ID，每次执行都不同。 */
  runId: RunId
  /** 节点配置（来自 {@link DagNodeDefinition.config}）。 */
  config: Record<string, unknown>
  /** 上游端口数据，key 为当前节点的输入端口名；有入边但上游未产生值的端口不出现。 */
  inputs: Record<string, unknown>
  /** 有入边的输入端口名，用于区分未连接的端口与上游未产生值的端口。 */
  connected: ReadonlySet<string>
  /** `${runId}/${nodeId}`，在同一运行中该节点的每次调用间保持不变，供节点自行去重或恢复。 */
  invocationKey: string
  /** 随运行记录持久化的节点私有值，在同一运行中该节点的重新调用间保留。 */
  notepad: NodeNotepad
  /**
   * 声明等待一个外部结果并等待其送达，例如人工回答、外部作业回调或另一系统的结果。
   * 请求与结果写入运行记录：节点被重新调用后，以相同 `requestId` 再次等待时，已送达的结果立即返回，
   * 未送达的请求继续等待，不会重复声明。
   * @param requestId - 节点内唯一且在重新调用间保持不变的请求 ID。
   * @param request - 请求内容；引擎不解释，浏览器按其 `kind` 字段选择渲染方式。
   * @returns 送达的结果；运行取消时拒绝。
   */
  awaitSignal(requestId: string, request: JsonValue): Promise<JsonValue>
  /** 取消信号。 */
  signal: AbortSignal
  /** 输出一条日志。 */
  log: (message: string) => void
}

/** 节点在同一运行的多次调用间保留的持久值。 */
export interface NodeNotepad {
  /** 最近一次保存的值；从未保存时为 undefined。每次读取返回独立副本。 */
  readonly value: JsonValue | undefined
  /**
   * 持久化新值，替换先前的值。
   * @param value - JSON 值；非 JSON 值（如 undefined、函数、非有限数值）会被拒绝。
   * @returns 值写入运行记录后兑现。
   */
  save(value: JsonValue): Promise<void>
}

/** 节点执行成功结果。 */
export interface NodeExecutionCompleted {
  status: 'completed'
  /** 输出端口数据；每个已声明的输出端口都必须有值，无内容时写 null。 */
  outputs: Record<string, unknown>
  /**
   * 本次完成触发的执行输出引脚，取自 {@link WorkflowNodeExecutor.execOutputs}。
   * 省略时触发全部已声明引脚；包含未声明引脚时节点失败。
   */
  next?: readonly string[]
}

/** 节点执行失败结果。 */
export interface NodeExecutionFailed {
  status: 'failed'
  /** 可直接写入运行记录的失败原因。 */
  error: string
  /** 失败前已产生的诊断输出。 */
  outputs?: Record<string, unknown>
}

/** 节点执行结果。节点不能自行跳过：不适用时以 completed 结束且不做任何事。 */
export type NodeExecutionResult = NodeExecutionCompleted | NodeExecutionFailed

/** 节点运行状态。等待外部结果的节点仍为 running；skipped 只由失效的执行边产生。 */
export type NodeRunStatus =
  | 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled'

/** 节点声明的一次外部结果等待。引擎不解释 {@link request} 和 {@link result}。 */
export interface NodeSignalRequest {
  /** 节点内唯一、在重新调用间保持不变的请求 ID。 */
  id: string
  /** 请求内容；浏览器按其 `kind` 字段选择渲染方式。 */
  request: JsonValue
  /** 已送达的结果；未送达时不存在。 */
  result?: JsonValue
  createdAt: number
  resolvedAt?: number
}

/** 节点运行记录。 */
export interface NodeRunRecord {
  nodeId: NodeId
  status: NodeRunStatus
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: string
  /** 节点在本次运行中被调用的次数，包括中断后的重新调用。 */
  attempts: number
  /** 节点通过 {@link NodeNotepad.save} 保存的最近值。 */
  notepad?: JsonValue
  /** 节点在本次运行中声明的外部结果等待，按声明顺序排列。 */
  requests?: NodeSignalRequest[]
  /** 节点完成时触发的执行输出引脚；未完成的节点不触发任何引脚。 */
  fired?: readonly string[]
  startedAt: number
  completedAt?: number
  runId: RunId
}

/** 工作流运行状态。 */
export type WorkflowRunStatus = 'running' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled'

/** 持久化的完整运行记录。 */
export interface WorkflowRunRecord {
  runId: RunId
  workflowId: WorkflowId
  /** 运行启动时的定义快照；之后对工作流的修改不影响该运行。 */
  definition: DagWorkflowDefinition
  status: WorkflowRunStatus
  error?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  nodes: NodeRunRecord[]
}

/** 运行列表中的一行。 */
export interface WorkflowRunSummary {
  runId: RunId
  workflowId: WorkflowId
  name: string
  status: WorkflowRunStatus
  /** 未结束运行中尚未送达结果的请求数量。 */
  pendingRequests: number
  /** 因执行边失效而被跳过的节点数量。 */
  skippedNodes: number
  error?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
}

/** 运行信息（事件负载用）。 */
export interface DagRunInfo {
  runId: RunId
  workflowId: WorkflowId
  name: string
  status: WorkflowRunStatus
}

/** 节点运行信息（事件负载用）。 */
export interface NodeRunInfo {
  nodeId: NodeId
  nodeType: string
  label: string
  status: NodeRunStatus
}

// ---- 节点插件接口 ----

/** 节点插件的执行器。通过 {@link WorkflowNodeRegistry.register} 注入。 */
export interface WorkflowNodeExecutor {
  /** 节点类型标识符（小写 kebab-case）。 */
  readonly type: string
  readonly label: string
  readonly description: string
  readonly inputs?: readonly PortDefinition[]
  readonly outputs?: readonly PortDefinition[]
  /**
   * 节点声明的执行输出引脚；省略时只有 `then`，在节点完成时触发。
   * 声明多个引脚的节点通过 {@link NodeExecutionCompleted.next} 选择本次触发哪些。
   */
  readonly execOutputs?: readonly string[]
  /** 浏览器节点卡片直接渲染的配置控件。 */
  readonly controls?: readonly NodeControlDefinition[]
  /** 节点实例可以声明的同型可变输入端口约束。 */
  readonly variadicInputs?: {
    readonly min: number
    readonly outputType?: 'same'
  }
  /** 中断后的恢复策略；省略时为 `rerun`。工作流节点的 `recovery` 覆盖此值。 */
  readonly recovery?: NodeRecoveryPolicy
  /**
   * 校验送达 {@link NodeExecutionContext.awaitSignal} 请求的结果。省略时引擎接受任何 JSON 值。
   * 引擎在写入运行记录前调用它，因此格式错误在送达方一侧被拒绝，而不是使节点失败。
   * @param request - 节点声明的请求内容。
   * @param result - 送达的结果。
   * @returns 写入运行记录的结果；结果无效时抛出。
   */
  validateSignal?(request: JsonValue, result: unknown): JsonValue
  /**
   * 执行节点。
   * @param context - 执行上下文，`inputs` 包含所有已产生值的输入端口。
   * @returns 节点执行结果。
   */
  execute(context: NodeExecutionContext): NodeExecutionResult | Promise<NodeExecutionResult>
}

/** 节点目录中的一个节点类型。 */
export interface NodeTypeSummary {
  type: string
  label: string
  description: string
  /** 注册该节点类型的 Cordis 插件名。 */
  sourcePlugin: string
  inputs: readonly PortDefinition[]
  outputs: readonly PortDefinition[]
  /** 节点类型的执行输出引脚，浏览器据此渲染执行引脚。 */
  execOutputs: readonly string[]
  controls: readonly NodeControlDefinition[]
  variadicInputs?: NonNullable<WorkflowNodeExecutor['variadicInputs']>
}

/** 浏览器编辑器启动时读取的已保存工作流与节点目录。 */
export interface WorkflowStudioSnapshot {
  readonly workflows: ReadonlyArray<{
    readonly id: WorkflowId
    readonly name: string
    readonly description?: string
    /** 格式化的定义 JSON。 */
    readonly definition: string
  }>
  readonly nodeTypes: readonly NodeTypeSummary[]
}
