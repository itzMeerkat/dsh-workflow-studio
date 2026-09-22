/**
 * 工作流节点基类。
 *
 * {@link WorkflowNode} 为节点作者实现 {@link WorkflowNodeExecutor}：子类声明身份、端口和
 * {@link WorkflowNode.run}，基类负责把 {@link NodeFailure} 转换为失败结果。
 * 注册表按字段接受执行器，不要求继承本类。
 * @module dsh-workflow-studio
 */

import type {
  NodeControlDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
  PortDefinition,
  WorkflowNodeExecutor,
} from './shared/types.ts'

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

/** {@link WorkflowNode} 子类声明的端口。 */
export interface WorkflowNodePorts {
  readonly inputs: readonly PortDefinition[]
  readonly outputs: readonly PortDefinition[]
}

/**
 * 把预期业务失败转换为失败结果，供自行实现 {@link WorkflowNodeExecutor.execute} 的节点复用。
 * @param error - 捕获到的错误。
 * @returns 对应的失败结果。
 * @throws 错误不是 {@link NodeFailure} 时原样抛出，因为那是缺陷而不是业务失败。
 */
export function toFailureResult(error: unknown): NodeExecutionResult {
  if (!(error instanceof NodeFailure)) throw error
  return error.outputs === undefined
    ? { status: 'failed', error: error.message }
    : { status: 'failed', error: error.message, outputs: error.outputs }
}

/**
 * 节点作者的抽象基类。
 *
 * 节点不能自行跳过：条件不成立时同样以 completed 结束，并为每个已声明的输出端口写值（无内容时写 null）。
 * 节点是否执行只由执行边决定。
 */
export abstract class WorkflowNode<Outputs extends Record<string, unknown> = Record<string, unknown>>
implements WorkflowNodeExecutor {
  /** 节点类型标识符（小写 kebab-case）。 */
  abstract readonly type: string
  abstract readonly label: string
  abstract readonly description: string
  /** 输入与输出端口。 */
  protected abstract readonly ports: WorkflowNodePorts
  declare readonly controls?: readonly NodeControlDefinition[]
  declare readonly execOutputs?: readonly string[]
  declare readonly variadicInputs?: NonNullable<WorkflowNodeExecutor['variadicInputs']>
  declare readonly kinds?: NonNullable<WorkflowNodeExecutor['kinds']>
  declare readonly validateSignal?: NonNullable<WorkflowNodeExecutor['validateSignal']>

  /**
   * 执行节点业务。
   * @param context - 引擎提供的执行上下文。
   * @returns 输出端口数据；预期失败时抛出 {@link NodeFailure}。
   */
  protected abstract run(context: NodeExecutionContext): Outputs | Promise<Outputs>

  get inputs(): PortDefinition[] {
    return [...this.ports.inputs]
  }

  get outputs(): PortDefinition[] {
    return [...this.ports.outputs]
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    try {
      return { status: 'completed', outputs: await this.run(context) }
    } catch (error: unknown) {
      return toFailureResult(error)
    }
  }
}
