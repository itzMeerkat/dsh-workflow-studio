/**
 * 测试用节点：覆盖引擎需要的普通节点、流程控制节点和可变输入节点。
 */

import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { askUser, validateQuestionsSignal } from '../src/shared/questions.ts'
import type { NodeControlDefinition, NodeExecutionContext, WorkflowNodeExecutor } from '../src/shared/types.ts'

/** `value`：输出 `config.value`。 */
export class ValueNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'value'
  readonly label = 'Value'
  readonly description = 'Outputs its configured value'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'output', type: 'any', display: 'json' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [
    { name: 'value', label: 'Value', kind: 'number', defaultValue: 0 },
  ]

  protected run({ config }: NodeExecutionContext): { output: unknown } {
    return { output: config.value ?? null }
  }
}

/** `sum`：数值相加并加上 `config.offset`。 */
export class SumNode extends WorkflowNode<{ result: number }> {
  readonly type = 'sum'
  readonly label = 'Sum'
  readonly description = 'Adds left, right, and the configured offset'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'left', type: 'number' }, { name: 'right', type: 'number' }],
    outputs: [{ name: 'result', type: 'number', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [
    { name: 'offset', label: 'Offset', kind: 'number', defaultValue: 0 },
  ]

  protected run({ config, inputs }: NodeExecutionContext): { result: number } {
    const { left, right } = inputs
    const offset = config.offset ?? 0
    if (typeof left !== 'number' || typeof right !== 'number' || typeof offset !== 'number') {
      throw new NodeFailure('left、right 和 offset 必须为数值')
    }
    return { result: left + right + offset }
  }
}

/** `greater`：输出 `left > right` 的布尔结果，供引擎的 branch 节点分叉执行流。 */
export class GreaterNode extends WorkflowNode<{ result: boolean }> {
  readonly type = 'greater'
  readonly label = 'Greater'
  readonly description = 'Reports whether left is greater than right'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'left', type: 'any' }, { name: 'right', type: 'any' }],
    outputs: [{ name: 'result', type: 'boolean' }],
  }

  protected run({ inputs }: NodeExecutionContext): { result: boolean } {
    return { result: (inputs.left as number) > (inputs.right as number) }
  }
}

/** `ask`：向人提问并输出所选标签。 */
export class AskNode extends WorkflowNode<{ answer: string }> {
  readonly type = 'ask'
  readonly label = 'Ask'
  readonly description = 'Asks one question and outputs the selected label'
  override readonly validateSignal = validateQuestionsSignal
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'answer', type: 'string' }],
  }

  protected async run(context: NodeExecutionContext): Promise<{ answer: string }> {
    const answer = await askUser(context, 'pick', [
      { id: 'decision', question: 'Go?', options: [{ label: 'yes' }, { label: 'no' }] },
    ])
    return { answer: answer.answers[0]?.selected[0] ?? '' }
  }
}

/** 所有测试用节点的新实例。 */
export function createFixtureNodes(): WorkflowNodeExecutor[] {
  return [new ValueNode(), new SumNode(), new GreaterNode(), new AskNode()]
}
