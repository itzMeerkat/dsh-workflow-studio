/**
 * 工作流节点基类。
 *
 * {@link WorkflowNode} 为节点作者实现 {@link WorkflowNodeExecutor}：子类声明身份、端口和 {@link WorkflowNode.run}，
 * 基类把 `run` 的返回值作为输出端口数据完成节点。注册表按字段接受执行器，不要求继承本类。
 * @module dsh-workflow-studio
 */

import type {
  NodeControlDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
  PortDefinition,
  WorkflowNodeExecutor,
} from './shared/types.ts'

/** {@link WorkflowNode} 子类声明的端口。 */
export interface WorkflowNodePorts {
  readonly inputs: readonly PortDefinition[]
  readonly outputs: readonly PortDefinition[]
}

/**
 * 节点作者的抽象基类。
 *
 * 节点不能自行跳过：条件不成立时同样完成，并为每个已声明的输出端口写值（无内容时写 null）。
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
  declare readonly exclusiveExecOutputs?: boolean
  declare readonly variadicInputs?: NonNullable<WorkflowNodeExecutor['variadicInputs']>
  declare readonly kinds?: NonNullable<WorkflowNodeExecutor['kinds']>
  declare readonly validateSignal?: NonNullable<WorkflowNodeExecutor['validateSignal']>

  /**
   * 执行节点业务。
   * @param context - 引擎提供的执行上下文。
   * @returns 输出端口数据。
   * @throws 节点自己处理不了的错误，见 {@link WorkflowNodeExecutor.execute}。
   */
  protected abstract run(context: NodeExecutionContext): Outputs | Promise<Outputs>

  get inputs(): PortDefinition[] {
    return [...this.ports.inputs]
  }

  get outputs(): PortDefinition[] {
    return [...this.ports.outputs]
  }

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    return { outputs: await this.run(context) }
  }
}
