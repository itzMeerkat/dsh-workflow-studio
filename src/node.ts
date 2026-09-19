/**
 * 工作流节点基类。
 *
 * {@link WorkflowNode} 为节点作者实现 {@link WorkflowNodeExecutor}：子类声明身份、业务端口和
 * {@link WorkflowNode.run}，基类负责 condition 门控、剥离 condition 输入以及把
 * {@link NodeFailure} 转换为失败结果。注册表按字段接受执行器，不要求继承本类。
 * @module dsh-workflow-studio
 */

import type {
  NodeControlDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
  PortDefinition,
  WorkflowNodeExecutor,
} from './shared/types.ts'

/** {@link WorkflowNode} 为条件节点追加的门控输入端口。 */
export const CONDITION_PORT: Readonly<PortDefinition> = {
  name: 'condition',
  type: 'boolean',
  description: '仅在输入为 true 时执行节点',
  required: false,
  role: 'condition',
}

/** 节点在 {@link WorkflowNode.run} 中抛出的预期业务失败。 */
export class NodeFailure extends Error {
  /**
   * @param message - 写入运行记录的失败原因。
   * @param outputs - 失败前已产生的诊断输出。
   */
  constructor(message: string, readonly outputs?: Record<string, unknown>) {
    super(message)
    this.name = 'NodeFailure'
  }
}

/** {@link WorkflowNode} 子类声明的业务端口，不含 condition。 */
export interface WorkflowNodePorts {
  readonly inputs: readonly PortDefinition[]
  readonly outputs: readonly PortDefinition[]
}

function toFailure(error: unknown): NodeExecutionResult {
  if (!(error instanceof NodeFailure)) throw error
  return error.outputs === undefined
    ? { status: 'failed', error: error.message }
    : { status: 'failed', error: error.message, outputs: error.outputs }
}

/**
 * 节点作者的抽象基类。
 *
 * 条件节点（默认）的输入端口为业务端口加 {@link CONDITION_PORT}。condition 端口有入边时：
 * 值为 true 执行节点，值为 false 或未产生值时跳过节点，其他值使节点失败；无入边时不影响执行。
 * 产生分支信号的流程控制节点将 {@link conditional} 设为 false，不获得 condition 端口。
 */
export abstract class WorkflowNode<Outputs extends Record<string, unknown> = Record<string, unknown>>
implements WorkflowNodeExecutor {
  /** 节点类型标识符（小写 kebab-case）。 */
  abstract readonly type: string
  abstract readonly label: string
  abstract readonly description: string
  /** 业务输入与输出端口；条件节点声明名为 condition 的输入时，注册表因端口重名拒绝注册。 */
  protected abstract readonly ports: WorkflowNodePorts
  declare readonly controls?: readonly NodeControlDefinition[]
  declare readonly variadicInputs?: NonNullable<WorkflowNodeExecutor['variadicInputs']>
  declare readonly requiresHumanInput?: boolean
  /** 为 false 时节点不获得 condition 端口，也不做门控。 */
  protected readonly conditional: boolean = true

  /**
   * 执行节点业务。`context.inputs` 不含 condition。
   * @param context - 引擎提供的执行上下文。
   * @returns 输出端口数据；预期失败时抛出 {@link NodeFailure}。
   */
  protected abstract run(context: NodeExecutionContext): Outputs | Promise<Outputs>

  get inputs(): PortDefinition[] {
    return this.conditional ? [...this.ports.inputs, CONDITION_PORT] : [...this.ports.inputs]
  }

  get outputs(): PortDefinition[] {
    return [...this.ports.outputs]
  }

  preflight(context: NodeExecutionContext): NodeExecutionResult | undefined {
    if (!this.conditional || !context.connected.has(CONDITION_PORT.name)) return undefined
    if (!Object.hasOwn(context.inputs, CONDITION_PORT.name)) return { status: 'skipped' }
    const condition = context.inputs[CONDITION_PORT.name]
    if (condition === true) return undefined
    if (condition === false) return { status: 'skipped' }
    return { status: 'failed', error: 'condition 输入必须为布尔值' }
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const inputs = this.conditional
      ? Object.fromEntries(Object.entries(context.inputs).filter(([name]) => name !== CONDITION_PORT.name))
      : context.inputs
    try {
      return { status: 'completed', outputs: await this.run({ ...context, inputs }) }
    } catch (error: unknown) {
      return toFailure(error)
    }
  }
}
