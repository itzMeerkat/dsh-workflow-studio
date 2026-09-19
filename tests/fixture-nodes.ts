/**
 * 测试用节点：覆盖引擎需要的普通节点、流程控制节点和可变输入节点。
 */

import type { Context } from '@deepseek-ai/cordis'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import type { NodeControlDefinition, NodeExecutionContext, WorkflowNodeExecutor } from '../src/types.ts'

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
    return { output: config.value }
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

/** `greater`：流程控制节点，`left > right` 时输出 `true`，否则输出 `false`。 */
export class GreaterNode extends WorkflowNode<{ true: true } | { false: true }> {
  readonly type = 'greater'
  readonly label = 'Greater'
  readonly description = 'Signals whether left is greater than right'
  protected override readonly conditional = false
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'left', type: 'any' }, { name: 'right', type: 'any' }],
    outputs: [{ name: 'true', type: 'boolean' }, { name: 'false', type: 'boolean' }],
  }

  protected run({ inputs }: NodeExecutionContext): { true: true } | { false: true } {
    return (inputs.left as number) > (inputs.right as number) ? { true: true } : { false: true }
  }
}

/** `merge`：可变输入的流程控制节点，输出唯一的非 null 输入。 */
export class MergeNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'merge'
  readonly label = 'Merge'
  readonly description = 'Outputs the single non-null input'
  protected override readonly conditional = false
  override readonly variadicInputs = { min: 2, outputType: 'same' as const }
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'input1', type: 'any', required: false },
      { name: 'input2', type: 'any', required: false },
    ],
    outputs: [{ name: 'output', type: 'any' }],
  }

  protected run({ inputs }: NodeExecutionContext): { output: unknown } {
    const values = Object.values(inputs).filter(value => value !== null)
    if (values.length !== 1) throw new NodeFailure(`merge 要求恰好一个非 null 输入，实际为 ${values.length} 个`)
    return { output: values[0] }
  }
}

/** 所有测试用节点的新实例。 */
export function createFixtureNodes(): WorkflowNodeExecutor[] {
  return [new ValueNode(), new SumNode(), new GreaterNode(), new MergeNode()]
}

/**
 * 在上下文的注册表中注册所有测试用节点。
 * @param ctx - 带有 workflowNodeRegistry 的上下文。
 */
export function registerFixtureNodes(ctx: Context): void {
  for (const node of createFixtureNodes()) ctx.workflowNodeRegistry.register(node, 'test-fixtures')
}
