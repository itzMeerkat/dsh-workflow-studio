/**
 * 把工作流的 IR 写成按执行顺序缩进的伪代码描述。
 *
 * IR 定好了顺序和条件块，这里只决定怎么写：每个节点写成对它类型的一次调用，子工作流写成对它嵌入的工作流的调用，
 * 实参按端口写出来源，条件写成 `节点.引脚`，工作流交付的输出写成赋值。
 * @module dsh-workflow-studio
 */

import type { IrBlock, IrCall, IrGuard, IrOutputs, IrValue, WorkflowIr } from './ir.ts'
import { SUBWORKFLOW_TYPE, subworkflowOf, type WorkflowLookup } from './subworkflow.ts'

const INDENT = '  '

/**
 * 把 IR 写成伪代码。
 *
 * 作者写的标签是可读的名字，但它不唯一；同名的节点一律退回节点 ID，引用才指向唯一一个节点。
 * @param ir - 工作流的 IR。
 * @param workflows - 读取子工作流节点嵌入的工作流；读不到时子工作流写成对 `subworkflow` 的调用。
 * @returns 描述，以一个换行结尾。
 */
export function describeWorkflow(ir: WorkflowIr, workflows: WorkflowLookup = () => undefined): string {
  const taken = new Set<string>()
  const name = identifier(ir.name, 'workflow', taken)
  const parameters = new Map(ir.inputs.map(port => [port.name, identifier(port.name, 'arg', taken)]))
  const calls = itemsOf(ir.body).filter(item => item.kind === 'call')
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.label ?? call.type, (counts.get(call.label ?? call.type) ?? 0) + 1)
  const names = new Map(calls.map((call) => {
    const display = call.label ?? call.type
    return [call.node, counts.get(display) === 1 ? display.replace(/\s+/g, '_') : call.node]
  }))
  const results = new Map(calls.map(call => [call.node, call.results.length]))
  const callName = (call: IrCall): string => {
    const embedded = call.type === SUBWORKFLOW_TYPE ? workflows(subworkflowOf(call.config)) : undefined
    return embedded === undefined ? call.type : embedded.name.replace(/\s+/g, '_')
  }
  const write = (value: IrValue): string => {
    if (value.kind === 'input') return parameters.get(value.port)!
    // 多输出节点的值按端口区分，单输出节点直接用节点的名字。
    return results.get(value.node)! > 1 ? `${names.get(value.node)!}.${value.port}` : names.get(value.node)!
  }
  const statement = (item: IrCall | IrOutputs): string => {
    if (item.kind === 'outputs') {
      // 输出端口收到的值就是工作流交付的值，因此写成赋值而不是实参。
      return `out: ${item.bindings.map(binding => `${binding.port} = ${write(binding.value)}`).join(', ')}`
    }
    const call = `${callName(item)}(${item.args.map(arg => `${arg.port}: ${write(arg.value)}`).join(', ')})`
    const name = names.get(item.node)!
    if (item.results.length > 0) return `${name} = ${call}`
    // 没有输出的节点不产生值，但条件块按名字引用它，所以名字与类型不同时仍要写出来。
    return name === item.type ? call : `${name}: ${call}`
  }

  const line = (depth: number, text: string): string => `${INDENT.repeat(depth)}${text}`
  const block = (items: IrBlock, depth: number): string[] => items.flatMap(item => item.kind === 'guard'
    ? guard(item, depth)
    : [line(depth, statement(item))])
  // arm 覆盖了决策节点的每个引脚时，最后一侧不必写条件。
  const armOpen = (item: IrGuard, index: number): string => {
    if (index > 0 && index === item.arms.length - 1 && item.arms.length === item.gate.pins.length) return 'else:'
    const condition = `${names.get(item.gate.node)!}.${item.arms[index]!.pin}`
    return index === 0 ? `if ${condition}:` : `else if ${condition}:`
  }
  const guard = (item: IrGuard, depth: number): string[] =>
    item.arms.flatMap((arm, index) => [line(depth, armOpen(item, index)), ...block(arm.body, depth + 1)])

  return [`workflow ${name}(${[...parameters.values()].join(', ')}):`, ...block(ir.body, 1)].join('\n') + '\n'
}

/** 块树中除条件块外的全部项，按写出的先后排列。 */
function itemsOf(block: IrBlock): (IrCall | IrOutputs)[] {
  return block.flatMap(item => item.kind === 'guard' ? item.arms.flatMap(arm => itemsOf(arm.body)) : [item])
}

/**
 * `text` 对应的、在 `taken` 中尚未占用的名字，并占用它。
 * @param text - 作者写的名字。
 * @param fallback - `text` 中没有可用字符时的前缀，后接序号。
 * @param taken - 已占用的名字；重名时加后缀。
 */
function identifier(text: string, fallback: string, taken: Set<string>): string {
  const cleaned = text.replaceAll(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\p{N})/u, '_')
  const base = /^_*$/.test(cleaned) ? `${fallback}${taken.size + 1}` : cleaned
  let name = base
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}_${suffix}`
  taken.add(name)
  return name
}
