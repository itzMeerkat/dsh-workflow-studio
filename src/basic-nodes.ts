/**
 * 内置基础 DAG 节点。
 *
 * 注册 input/arithmetic/if/coalesce/output 五个节点到 {@link ctx.workflowNodeRegistry}。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import jexl from 'jexl'
import type { WorkflowNodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.ts'

const expressionEngine = new jexl.Jexl()
expressionEngine.addBinaryOp('===', 20, (left: unknown, right: unknown) => left === right)
expressionEngine.addBinaryOp('!==', 20, (left: unknown, right: unknown) => left !== right)

/** input 节点：提供固定数值输入（演示用）。 */
const inputNode: WorkflowNodeExecutor = {
  type: 'input',
  label: '输入',
  description: '提供一个可配置的数值输入',
  inputs: [],
  outputs: [{ name: 'output', type: 'number', description: '输出数值', display: 'value' }],
  controls: [{
    name: 'defaultValue',
    label: '数值',
    kind: 'number',
    defaultValue: 0,
    step: 1,
  }],
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const value = ctx.config.defaultValue ?? 0
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { status: 'failed', error: 'defaultValue 必须为有限数值' }
    }
    return { status: 'completed', outputs: { output: value } }
  },
}

/** arithmetic 节点：四则运算。 */
const arithmeticNode: WorkflowNodeExecutor = {
  type: 'arithmetic',
  label: '四则运算',
  description: '对 left 和 right 两个输入执行四则运算',
  inputs: [
    { name: 'left', type: 'number', description: '左操作数' },
    { name: 'right', type: 'number', description: '右操作数' },
  ],
  outputs: [{ name: 'result', type: 'number', description: '运算结果', display: 'value' }],
  controls: [{
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
  }],
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const left = ctx.inputs.left
    const right = ctx.inputs.right
    if (typeof left !== 'number' || !Number.isFinite(left)
      || typeof right !== 'number' || !Number.isFinite(right)) {
      return { status: 'failed', error: 'left 和 right 必须为有限数值' }
    }
    const op = ctx.config.operator ?? 'add'
    if (typeof op !== 'string') {
      return { status: 'failed', error: 'operator 必须为字符串' }
    }

    let result: number
    switch (op) {
      case 'add':
        result = left + right
        break
      case 'subtract':
        result = left - right
        break
      case 'multiply':
        result = left * right
        break
      case 'divide':
        if (right === 0) {
          return { status: 'failed', error: '除数不能为 0' }
        }
        result = left / right
        break
      default:
        return { status: 'failed', error: `不支持的运算符: ${op}` }
    }

    return { status: 'completed', outputs: { result } }
  },
}

/** if 节点：计算两个输入上的受限表达式并产生互斥门控信号。 */
const ifNode: WorkflowNodeExecutor = {
  type: 'if',
  label: '条件分支',
  description: '计算 left 和 right 上的 JS 风格表达式并产生分支信号',
  acceptsCondition: false,
  inputs: [
    { name: 'left', type: 'any', description: '表达式变量 left' },
    { name: 'right', type: 'any', description: '表达式变量 right' },
  ],
  outputs: [
    { name: 'true', type: 'boolean', description: '条件成立时产生 true', display: 'value' },
    { name: 'false', type: 'boolean', description: '条件不成立时产生 true', display: 'value' },
  ],
  controls: [{
    name: 'expression',
    label: '表达式',
    kind: 'text',
    defaultValue: 'left === right',
    placeholder: 'left === right',
  }],
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const expression = ctx.config.expression ?? 'left === right'
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { status: 'failed', error: 'expression 必须为非空字符串' }
    }

    let condition: unknown
    try {
      condition = expressionEngine.evalSync(expression, {
        left: ctx.inputs.left,
        right: ctx.inputs.right,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed', error: `expression 执行失败: ${message}` }
    }
    if (typeof condition !== 'boolean') {
      return { status: 'failed', error: 'expression 必须返回布尔值' }
    }
    return condition
      ? { status: 'completed', outputs: { true: true } }
      : { status: 'completed', outputs: { false: true } }
  },
}

/** coalesce 节点：合并互斥分支产生的同型数据。 */
const coalesceNode: WorkflowNodeExecutor = {
  type: 'coalesce',
  label: '分支合并',
  description: '从多个同型输入中选择唯一的非 null 值',
  acceptsCondition: false,
  variadicInputs: { min: 2, outputType: 'same' },
  inputs: [
    { name: 'input1', type: 'any', description: '候选输入 1', required: false },
    { name: 'input2', type: 'any', description: '候选输入 2', required: false },
  ],
  outputs: [{ name: 'output', type: 'any', description: '唯一的非 null 输入', display: 'json' }],
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const values = Object.values(ctx.inputs).filter(value => value !== null)
    if (values.length !== 1) {
      return {
        status: 'failed',
        error: `coalesce 要求恰好一个非 null 输入，实际为 ${values.length} 个`,
      }
    }
    return { status: 'completed', outputs: { output: values[0] } }
  },
}

/** output 节点：输出最终结果。 */
const outputNode: WorkflowNodeExecutor = {
  type: 'output',
  label: '输出',
  description: '收集最终的运行结果',
  inputs: [{ name: 'input', type: 'any', description: '要输出的值' }],
  outputs: [{ name: 'output', type: 'any', description: '最终结果', display: 'json' }],
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const value = ctx.inputs.input
    ctx.log(`输出结果: ${JSON.stringify(value)}`)
    return { status: 'completed', outputs: { output: value } }
  },
}

export const BUILTIN_NODES: WorkflowNodeExecutor[] = [
  inputNode,
  arithmeticNode,
  ifNode,
  coalesceNode,
  outputNode,
]

/** 在插件 apply 时注册所有内置节点。返回 disposer。 */
export function registerBuiltinNodes(ctx: Context): () => void {
  const reg = ctx.workflowNodeRegistry
  for (const node of BUILTIN_NODES) {
    if (reg.get(node.type) !== undefined) {
      throw new Error(`节点类型 "${node.type}" 已注册`)
    }
  }

  const disposers: Array<() => void> = []
  try {
    for (const node of BUILTIN_NODES) {
      disposers.push(reg.register(node, 'dsh-workflow-studio'))
    }
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
