/**
 * 演示节点：input/arithmetic/if/coalesce/output。
 *
 * 这些节点只用于演示和测试 {@link WorkflowNode}，不是 Workflow Studio 核心功能。
 * @module dsh-workflow-studio/demo
 */

import jexl from 'jexl'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../node.ts'
import type { NodeControlDefinition, NodeExecutionContext, WorkflowNodeExecutor } from '../types.ts'

const expressionEngine = new jexl.Jexl()
expressionEngine.addBinaryOp('===', 20, (left: unknown, right: unknown) => left === right)
expressionEngine.addBinaryOp('!==', 20, (left: unknown, right: unknown) => left !== right)

/** input 节点：提供可配置的数值。 */
export class InputNode extends WorkflowNode<{ output: number }> {
  readonly type = 'input'
  readonly label = '输入'
  readonly description = '提供一个可配置的数值输入'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'output', type: 'number', description: '输出数值', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'defaultValue',
    label: '数值',
    kind: 'number',
    defaultValue: 0,
    step: 1,
  }]

  protected run(ctx: NodeExecutionContext): { output: number } {
    const value = ctx.config.defaultValue ?? 0
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new NodeFailure('defaultValue 必须为有限数值')
    }
    return { output: value }
  }
}

/** arithmetic 节点：四则运算。 */
export class ArithmeticNode extends WorkflowNode<{ result: number }> {
  readonly type = 'arithmetic'
  readonly label = '四则运算'
  readonly description = '对 left 和 right 两个输入执行四则运算'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'left', type: 'number', description: '左操作数' },
      { name: 'right', type: 'number', description: '右操作数' },
    ],
    outputs: [{ name: 'result', type: 'number', description: '运算结果', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'operator',
    label: '运算',
    kind: 'select',
    defaultValue: 'add',
    options: [
      { label: '加', value: 'add' },
      { label: '减', value: 'subtract' },
      { label: '乘', value: 'multiply' },
      { label: '除', value: 'divide' },
    ],
  }]

  protected run(ctx: NodeExecutionContext): { result: number } {
    const left = ctx.inputs.left
    const right = ctx.inputs.right
    if (typeof left !== 'number' || !Number.isFinite(left)
      || typeof right !== 'number' || !Number.isFinite(right)) {
      throw new NodeFailure('left 和 right 必须为有限数值')
    }
    const op = ctx.config.operator ?? 'add'
    if (typeof op !== 'string') throw new NodeFailure('operator 必须为字符串')
    switch (op) {
      case 'add':
        return { result: left + right }
      case 'subtract':
        return { result: left - right }
      case 'multiply':
        return { result: left * right }
      case 'divide':
        if (right === 0) throw new NodeFailure('除数不能为 0')
        return { result: left / right }
      default:
        throw new NodeFailure(`不支持的运算符: ${op}`)
    }
  }
}

/** if 节点：计算两个输入上的受限表达式并产生互斥门控信号。 */
export class IfNode extends WorkflowNode<{ true: true } | { false: true }> {
  readonly type = 'if'
  readonly label = '条件分支'
  readonly description = '计算 left 和 right 上的 JS 风格表达式并产生分支信号'
  protected override readonly conditional = false
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'left', type: 'any', description: '表达式变量 left' },
      { name: 'right', type: 'any', description: '表达式变量 right' },
    ],
    outputs: [
      { name: 'true', type: 'boolean', description: '条件成立时产生 true', display: 'value' },
      { name: 'false', type: 'boolean', description: '条件不成立时产生 true', display: 'value' },
    ],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'expression',
    label: '表达式',
    kind: 'text',
    defaultValue: 'left === right',
    placeholder: 'left === right',
  }]

  protected run(ctx: NodeExecutionContext): { true: true } | { false: true } {
    const expression = ctx.config.expression ?? 'left === right'
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new NodeFailure('expression 必须为非空字符串')
    }
    let condition: unknown
    try {
      condition = expressionEngine.evalSync(expression, {
        left: ctx.inputs.left,
        right: ctx.inputs.right,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new NodeFailure(`expression 执行失败: ${message}`)
    }
    if (typeof condition !== 'boolean') throw new NodeFailure('expression 必须返回布尔值')
    return condition ? { true: true } : { false: true }
  }
}

/** coalesce 节点：合并互斥分支产生的同型数据。 */
export class CoalesceNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'coalesce'
  readonly label = '分支合并'
  readonly description = '从多个同型输入中选择唯一的非 null 值'
  protected override readonly conditional = false
  override readonly variadicInputs: NonNullable<WorkflowNodeExecutor['variadicInputs']> = { min: 2, outputType: 'same' }
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'input1', type: 'any', description: '候选输入 1', required: false },
      { name: 'input2', type: 'any', description: '候选输入 2', required: false },
    ],
    outputs: [{ name: 'output', type: 'any', description: '唯一的非 null 输入', display: 'json' }],
  }

  protected run(ctx: NodeExecutionContext): { output: unknown } {
    const values = Object.values(ctx.inputs).filter(value => value !== null)
    if (values.length !== 1) {
      throw new NodeFailure(`coalesce 要求恰好一个非 null 输入，实际为 ${values.length} 个`)
    }
    return { output: values[0] }
  }
}

/** output 节点：输出最终结果。 */
export class OutputNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'output'
  readonly label = '输出'
  readonly description = '收集最终的运行结果'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'input', type: 'any', description: '要输出的值' }],
    outputs: [{ name: 'output', type: 'any', description: '最终结果', display: 'json' }],
  }

  protected run(ctx: NodeExecutionContext): { output: unknown } {
    const value = ctx.inputs.input
    ctx.log(`输出结果: ${JSON.stringify(value)}`)
    return { output: value }
  }
}

/** 所有演示节点的新实例。 */
export function createDemoNodes(): WorkflowNodeExecutor[] {
  return [new InputNode(), new ArithmeticNode(), new IfNode(), new CoalesceNode(), new OutputNode()]
}
