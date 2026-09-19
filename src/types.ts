/**
 * dsh-workflow-studio 核心类型定义。
 *
 * 定义 DAG 工作流的节点/边/运行期类型，以及节点插件和引擎接口。
 * @module dsh-workflow-studio
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

// ---- Branded IDs ----

/** 工作流定义 ID。 */
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
  /** 输入端口是否必须连接；省略时为 true。 */
  required?: boolean
  /** 引擎赋予该端口的特殊执行语义。 */
  role?: 'condition'
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
  /** 是否需人工确认后执行。 */
  requiresHumanInput?: boolean
  /** 覆盖执行器声明的中断恢复策略。 */
  recovery?: NodeRecoveryPolicy
  /** 可视化编辑器中的节点坐标。 */
  position?: { x: number; y: number }
  /** 节点声明的输出端口；省略时使用执行器声明。 */
  outputs?: PortDefinition[]
  /** 节点声明的输入端口；省略时使用执行器声明。 */
  inputs?: PortDefinition[]
}

/** DAG 边定义。 */
export interface DagEdgeDefinition {
  id: EdgeId
  source: NodeId
  /** 源节点输出端口（默认 "output"）。 */
  sourcePort?: string
  target: NodeId
  /** 目标节点输入端口（默认 "input"）。 */
  targetPort?: string
}

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
  /** 输出端口数据，key 为端口名。 */
  outputs: Record<string, unknown>
}

/** 节点执行失败结果。 */
export interface NodeExecutionFailed {
  status: 'failed'
  /** 可直接写入运行记录的失败原因。 */
  error: string
  /** 失败前已产生的诊断输出。 */
  outputs?: Record<string, unknown>
}

/** 节点自行决定不执行的结果；下游缺少其数据的必需输入时同样被跳过。 */
export interface NodeExecutionSkipped {
  status: 'skipped'
}

/** 节点执行结果。 */
export type NodeExecutionResult = NodeExecutionCompleted | NodeExecutionFailed | NodeExecutionSkipped

/** 节点运行状态。 */
export type NodeRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'skipped' | 'failed' | 'cancelled'

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
  error?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
}

/** 工作流运行结果。 */
export interface WorkflowResult {
  runId: RunId
  workflowId: WorkflowId
  name: string
  status: WorkflowRunStatus
  error?: string
  nodeRecords: NodeRunRecord[]
  startedAt: number
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
  readonly inputs?: PortDefinition[]
  readonly outputs?: PortDefinition[]
  /** 浏览器节点卡片直接渲染的配置控件。 */
  readonly controls?: readonly NodeControlDefinition[]
  /** 节点实例可以声明的同型可变输入端口约束。 */
  readonly variadicInputs?: {
    readonly min: number
    readonly outputType?: 'same'
  }
  /** 是否需要人工介入执行该节点。 */
  readonly requiresHumanInput?: boolean
  /** 中断后的恢复策略；省略时为 `rerun`。工作流节点的 `recovery` 覆盖此值。 */
  readonly recovery?: NodeRecoveryPolicy
  /**
   * 在引擎的输入检查和人工确认之前调用。返回结果时节点直接以该结果结束，不调用 {@link execute}；
   * 返回 undefined 时继续执行。
   * @param context - 与随后 {@link execute} 相同的执行上下文。
   * @returns 结束节点的结果，或 undefined。
   */
  preflight?(context: NodeExecutionContext): NodeExecutionResult | undefined
  /**
   * 执行节点。
   * @param context - 执行上下文，`inputs` 包含所有已产生值的输入端口。
   * @returns 节点执行结果。
   */
  execute(context: NodeExecutionContext): NodeExecutionResult | Promise<NodeExecutionResult>
}
