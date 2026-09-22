/**
 * `code` 工作流的节点：每个节点携带一段它所在工作流的语言的代码。
 *
 * 这些节点只被写成源码，从不运行，所以 `execute` 明确失败。生成器按类型决定怎么写它们，
 * 因此它们与生成器一起由本插件注册。
 * @module dsh-workflow-studio
 */

import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from './node.ts'
import { CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, CODE_FIELD, CODE_FUNCTION_TYPE } from './shared/language.ts'
import type { NodeControlDefinition, WorkflowKind, WorkflowNodeExecutor } from './shared/types.ts'

/** 共同的部分：一个编辑代码的控件，只用于 `code` 工作流，不能运行。 */
abstract class CodeNode extends WorkflowNode {
  override readonly kinds: readonly WorkflowKind[] = ['code']
  override readonly controls: readonly NodeControlDefinition[]

  /** @param control - 编辑 {@link CODE_FIELD} 的控件。 */
  constructor(control: NodeControlDefinition) {
    super()
    this.controls = [control]
  }

  protected run(): never {
    throw new NodeFailure(`${this.type} 节点只被写成源码，不能运行`)
  }
}

/** 一段语句。 */
class CodeBlockNode extends CodeNode {
  readonly type = CODE_BLOCK_TYPE
  readonly label = '代码块'
  readonly description = '一段语句，按它在图中的位置和所属分支原样写出'
  protected readonly ports: WorkflowNodePorts = { inputs: [], outputs: [] }
}

/** 一行表达式；它的输出不携带运行期的值，只让读它的节点指明读的是哪个表达式。 */
class CodeConditionNode extends CodeNode {
  readonly type = CODE_CONDITION_TYPE
  readonly label = '代码条件'
  readonly description = '一行表达式，写进读它的地方，例如连到分支节点的 condition'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'value', type: 'boolean', description: '连到 branch 的 condition' }],
  }
}

/** 一个函数；节点实例的端口由浏览器按它的签名写入定义，类型本身不声明端口。 */
class CodeFunctionNode extends CodeNode {
  readonly type = CODE_FUNCTION_TYPE
  readonly label = '代码函数'
  readonly description = '一个函数，参数是输入端口、结果是输出端口；写在文件顶层，在图中的位置被调用'
  protected readonly ports: WorkflowNodePorts = { inputs: [], outputs: [] }
}

/** 每种代码节点的新实例；函数往往很长，所以从文件读入而不在卡片上编辑。 */
export function createCodeNodes(): WorkflowNodeExecutor[] {
  const textarea = (label: string, placeholder: string, rows: number): NodeControlDefinition =>
    ({ name: CODE_FIELD, label, kind: 'textarea', defaultValue: '', placeholder, rows })
  return [
    new CodeBlockNode(textarea('代码', 'result = compute(value)', 8)),
    new CodeConditionNode(textarea('条件', 'amount > 100', 2)),
    new CodeFunctionNode({ name: CODE_FIELD, label: '函数文件', kind: 'file', defaultValue: '' }),
  ]
}
