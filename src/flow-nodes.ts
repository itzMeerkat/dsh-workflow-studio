/**
 * 引擎自有的流程控制节点。
 *
 * 这些节点的行为本身就是执行语义，因此由核心插件注册，而不是交给节点插件：
 * {@link BranchNode} 是唯一产生条件分支的节点，{@link MergeNode} 是唯一的 OR 连接点。
 * 其余节点类型一律是 AND 连接，且只能通过完成与否影响下游。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { createCodeNodes } from './code-nodes.ts'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from './node.ts'
import {
  WORKFLOW_INPUT_TYPE, WORKFLOW_INPUT_VALUES, WORKFLOW_OUTPUT_TYPE,
} from './shared/workflow-boundary.ts'
import type {
  NodeExecKind, NodeExecutionContext, NodeExecutionResult, PortDefinition, WorkflowKind,
  WorkflowNodeExecutor,
} from './shared/types.ts'

/** {@link BranchNode} 条件成立时触发的执行输出引脚。 */
export const BRANCH_TRUE_PIN = 'true'

/** {@link BranchNode} 条件不成立时触发的执行输出引脚。 */
export const BRANCH_FALSE_PIN = 'false'

/**
 * 按布尔输入触发两个互斥执行引脚之一的分支节点。
 *
 * 它不产生数据；比较和判断由上游节点完成，本节点只把布尔结果变成执行流的分叉。
 */
export class BranchNode implements WorkflowNodeExecutor {
  readonly type = 'branch'
  readonly kinds: readonly WorkflowKind[] = ['run', 'code']
  readonly label = '条件分支'
  readonly description = '按布尔输入触发 true 或 false 执行引脚'
  readonly execOutputs: readonly string[] = [BRANCH_TRUE_PIN, BRANCH_FALSE_PIN]
  readonly inputs: readonly PortDefinition[] = [
    { name: 'condition', type: 'boolean', description: '决定触发哪个执行引脚' },
  ]
  readonly outputs: readonly PortDefinition[] = []

  execute({ inputs }: NodeExecutionContext): NodeExecutionResult {
    if (typeof inputs.condition !== 'boolean') {
      return { status: 'failed', error: 'condition 输入必须为布尔值' }
    }
    return {
      status: 'completed',
      outputs: {},
      next: [inputs.condition ? BRANCH_TRUE_PIN : BRANCH_FALSE_PIN],
    }
  }
}

/**
 * 合并互斥分支的 OR 连接点。
 *
 * 只要有一条入执行边触发，本节点就执行；全部失效时才被跳过。它透传唯一送达的输入，
 * 因此分支两侧的数据可以在此汇合成一条下游数据边。
 */
export class MergeNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'merge'
  override readonly kinds: readonly WorkflowKind[] = ['run', 'code']
  readonly label = '分支合并'
  readonly description = '从互斥分支中透传唯一送达的输入'
  override readonly variadicInputs: NonNullable<WorkflowNodeExecutor['variadicInputs']> = { min: 2, outputType: 'same' }
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'input1', type: 'any', description: '候选输入 1', required: false },
      { name: 'input2', type: 'any', description: '候选输入 2', required: false },
    ],
    outputs: [{ name: 'output', type: 'any', description: '唯一送达的输入', display: 'json' }],
  }

  protected run({ inputs }: NodeExecutionContext): { output: unknown } {
    const supplied = Object.values(inputs)
    if (supplied.length !== 1) {
      throw new NodeFailure(`merge 要求恰好一个送达的输入，实际为 ${supplied.length} 个`)
    }
    return { output: supplied[0] }
  }
}

/**
 * 把调用方提供的工作流输入送入图中的边界节点。
 *
 * 工作流接受哪些输入就是本节点声明了哪些输出端口，因此执行器自身不声明端口。
 * 运行开始前已解析出每个端口的值，所以本节点只是把它们原样交给下游。
 */
export class WorkflowInputNode implements WorkflowNodeExecutor {
  readonly type = WORKFLOW_INPUT_TYPE
  readonly kinds: readonly WorkflowKind[] = ['run', 'code']
  readonly label = '工作流输入'
  readonly description = '把调用方提供的工作流输入送入图中'
  readonly inputs: readonly PortDefinition[] = []
  readonly outputs: readonly PortDefinition[] = []

  execute({ config }: NodeExecutionContext): NodeExecutionResult {
    const values = config[WORKFLOW_INPUT_VALUES]
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      return { status: 'failed', error: '工作流输入节点缺少本次运行的输入值' }
    }
    return { status: 'completed', outputs: { ...values as Record<string, unknown> } }
  }
}

/**
 * 收集工作流输出的边界节点。
 *
 * 工作流产出哪些输出就是本节点声明了哪些输入端口。收到的值记录在节点运行记录的 `inputs` 上，
 * 运行记录再把它们提升为整个运行的输出，因此本节点不声明输出端口，也就不受输出完整性检查约束。
 */
export class WorkflowOutputNode implements WorkflowNodeExecutor {
  readonly type = WORKFLOW_OUTPUT_TYPE
  readonly kinds: readonly WorkflowKind[] = ['run', 'code']
  readonly label = '工作流输出'
  readonly description = '收集工作流声明的输出值'
  readonly inputs: readonly PortDefinition[] = []
  readonly outputs: readonly PortDefinition[] = []

  execute(): NodeExecutionResult {
    return { status: 'completed', outputs: {} }
  }
}

const branchNode = new BranchNode()
const mergeNode = new MergeNode()

/**
 * 执行器的执行语义。
 *
 * 按实例身份判断，因此第三方节点即使使用相同类型名或字段也无法获得 `decision` 或 `join` 语义。
 * @param executor - 运行中解析到的节点执行器。
 */
export function execKindOf(executor: WorkflowNodeExecutor): NodeExecKind {
  if (executor === mergeNode) return 'join'
  if (executor === branchNode) return 'decision'
  return 'plain'
}

/**
 * 注册引擎自有的节点：流程控制节点、边界节点和 `code` 工作流的代码节点。
 * @param ctx - 已加载 workflowNodeRegistry 服务的 Cordis context。
 */
export function registerBuiltinNodes(ctx: Context): void {
  const nodes: readonly WorkflowNodeExecutor[] = [
    branchNode, mergeNode, new WorkflowInputNode(), new WorkflowOutputNode(), ...createCodeNodes(),
  ]
  for (const node of nodes) {
    ctx.effect(() => ctx.workflowNodeRegistry.register(node, 'dsh-workflow-studio'), `builtin-node:${node.type}`)
  }
}
