/**
 * 把工作流的 IR 写成它的语言的源码。
 *
 * 伪代码和代码生成是同一次遍历：IR 定好了顺序和条件块，{@link Language} 决定块怎么开合、
 * 函数怎么声明、条件怎么取反；工作流的种类决定一项写成什么：`run` 工作流的节点写成对节点类型的调用，
 * `code` 工作流的节点携带代码，语句原样写出，函数写在文件顶层并按数据边调用。
 * @module dsh-workflow-studio
 */

import type { IrBlock, IrCall, IrGuard, IrOutputs, IrValue, WorkflowIr } from './ir.ts'
import {
  CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, CODE_FUNCTION_TYPE, codeOf, type Language, type Signature,
} from './language.ts'
import type { NodeId, PortDefinition } from './types.ts'

/** 一种语言写不出的图，`node` 是需要修改的节点。 */
export type RenderFault =
  /** 条件块的守卫节点不是决策节点，它的引脚不对应任何表达式。 */
  | { readonly code: 'not-a-decision'; readonly node: NodeId }
  /** 决策节点的条件输入没有接线。 */
  | { readonly code: 'no-condition'; readonly node: NodeId }
  /** 作为条件的代码不止一行。 */
  | { readonly code: 'multiline-condition'; readonly node: NodeId }
  /** 函数节点的代码不是该语言能读出签名的函数。 */
  | { readonly code: 'not-a-function'; readonly node: NodeId }
  /** 函数的必需参数 `port` 没有接线。 */
  | { readonly code: 'unwired-parameter'; readonly node: NodeId; readonly port: string }
  /** 生成的代码中没有保存这个节点产出的值：它既不是函数的结果，也不是只汇合函数结果的分支合并。 */
  | { readonly code: 'no-value'; readonly node: NodeId }

/** 写不出源码的原因；文案由使用它的界面按 {@link RenderFault} 组织。 */
export class RenderError extends Error {
  constructor(readonly fault: RenderFault) {
    super(`${fault.code}: ${fault.node}`)
    this.name = 'RenderError'
  }
}

/**
 * 把 IR 写成一种语言的一个函数。
 * @param ir - 工作流的 IR。
 * @param language - 工作流的语言，即 {@link languageOf} 的结果。
 * @returns 源码，以一个换行结尾。
 * @throws {@link RenderError} 图中有该语言写不出的结构时。
 */
export function renderWorkflow(ir: WorkflowIr, language: Language): string {
  const content = contentOf(ir, language)
  const line = (depth: number, text: string): string => text === '' ? '' : `${language.indent.repeat(depth)}${text}`
  const close = (depth: number): string[] => language.blockEnd === undefined ? [] : [line(depth, language.blockEnd)]
  const block = (items: IrBlock, depth: number): string[] => {
    const lines = items.flatMap(item => item.kind === 'guard'
      ? guard(item, depth)
      : content.statement(item).map(text => line(depth, text)))
    return lines.length > 0 || language.emptyBlock === undefined ? lines : [line(depth, language.emptyBlock)]
  }
  // 另一侧的开启行自带上一侧的闭合（例如 `} else {`），所以块只在最后一侧之后闭合。
  const guard = (item: IrGuard, depth: number): string[] => [
    ...item.arms.flatMap((arm, index) => [
      line(depth, index === 0
        ? fill(language.conditionOpen, { condition: content.condition(item.gate, arm.pin) })
        : language.otherwiseOpen),
      ...block(arm.body, depth + 1),
    ]),
    ...close(depth),
  ]

  return [
    ...content.preamble,
    content.open,
    ...content.prologue.map(text => line(1, text)),
    ...block(ir.body, 1),
    ...content.epilogue.map(text => line(1, text)),
    ...close(0),
  ].join('\n') + '\n'
}

/** 一种工作流的节点写成什么。 */
interface Content {
  /** 生成函数之前的行。 */
  readonly preamble: readonly string[]
  /** 开启生成函数的一行。 */
  readonly open: string
  /** 函数体开头的行，不含缩进。 */
  readonly prologue: readonly string[]
  /** 函数体末尾的行，不含缩进。 */
  readonly epilogue: readonly string[]
  /** 一项的行，不含缩进。 */
  statement(item: IrCall | IrOutputs): readonly string[]
  /** `gate` 触发 `pin` 的条件表达式。 */
  condition(gate: IrCall, pin: string): string
}

function contentOf(ir: WorkflowIr, language: Language): Content {
  switch (ir.kind) {
    case 'run':
      return runContent(ir, language)
    case 'code':
      return codeContent(ir, language)
    default:
      return assertNever(ir.kind)
  }
}

/**
 * `run` 工作流：每个节点写成对它类型的一次调用，实参按端口写出来源，条件写成 `节点.引脚`。
 *
 * 作者写的标签是可读的名字，但它不唯一；同名的节点一律退回节点 ID，引用才指向唯一一个节点。
 */
function runContent(ir: WorkflowIr, language: Language): Content {
  const identifiers = new Identifiers(language.reserved)
  const name = identifiers.take(ir.name, 'workflow')
  const parameters = new Map(ir.inputs.map(port => [port.name, identifiers.take(port.name, 'arg')]))
  const calls = itemsOf(ir.body).filter(item => item.kind === 'call')
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.label ?? call.type, (counts.get(call.label ?? call.type) ?? 0) + 1)
  const names = new Map(calls.map((call) => {
    const display = call.label ?? call.type
    return [call.node, counts.get(display) === 1 ? display.replace(/\s+/g, '_') : call.node]
  }))
  const results = new Map(calls.map(call => [call.node, call.results.length]))

  const write = (value: IrValue): string => {
    if (value.kind === 'input') return parameters.get(value.port)!
    // 多输出节点的值按端口区分，单输出节点直接用节点的名字。
    return results.get(value.node)! > 1 ? `${names.get(value.node)!}.${value.port}` : names.get(value.node)!
  }
  return {
    preamble: [],
    open: fill(language.functionOpen, { name, parameters: [...parameters.values()].join(', '), results: '' }),
    prologue: [],
    epilogue: [],
    statement(item) {
      if (item.kind === 'outputs') {
        // 输出端口收到的值就是工作流交付的值，因此写成赋值而不是实参。
        return [`out: ${item.bindings.map(binding => `${binding.port} = ${write(binding.value)}`).join(', ')}`]
      }
      const call = `${item.type}(${item.args.map(arg => `${arg.port}: ${write(arg.value)}`).join(', ')})`
      const name = names.get(item.node)!
      if (item.results.length > 0) return [`${name} = ${call}`]
      // 没有输出的节点不产生值，但条件块按名字引用它，所以名字与类型不同时仍要写出来。
      return [name === item.type ? call : `${name}: ${call}`]
    },
    condition: (gate, pin) => `${names.get(gate.node)!}.${pin}`,
  }
}

/**
 * `code` 工作流：节点携带的代码按类型写出，编译器只读函数的签名，不解析其余代码。
 *
 * 语句节点的代码按所在的块重新缩进后原样写出；表达式节点写进读它的值的地方；函数节点写在文件顶层，
 * 在图中的位置调用它，实参按参数名取自数据边。函数的结果只有被读时才存进变量，这些变量在函数体开头声明；
 * 分支合并不产生代码，汇合到它的结果直接存进它的变量。决策节点按它的第一个输入决定，
 * 第一个引脚是条件成立的一侧，另一个是它的取反。
 */
function codeContent(ir: WorkflowIr, language: Language): Content {
  const functions = language.functions
  const identifiers = new Identifiers(language.reserved)
  const items = itemsOf(ir.body)
  const calls = new Map(items.flatMap(item => item.kind === 'call' ? [[item.node, item] as const] : []))

  // 具名函数的名字由代码写定，先占用，其余标识符都避开它们。
  const signatures = new Map<NodeId, Signature>()
  for (const call of calls.values()) {
    if (call.type !== CODE_FUNCTION_TYPE) continue
    const signature = functions?.signature(codeOf(call.config))
    if (signature === undefined) throw new RenderError({ code: 'not-a-function', node: call.node })
    signatures.set(call.node, signature)
    if (signature.name !== undefined) identifiers.reserve(signature.name)
  }
  const name = identifiers.take(ir.name, 'workflow')
  const parameters = new Map(ir.inputs.map(port => [port.name, identifiers.take(port.name, 'arg')]))
  const results = new Map(ir.outputs.map(port => [port.name, identifiers.take(port.name, 'result')]))
  const callees = new Map([...signatures].map(([node, signature]) =>
    [node, signature.name ?? identifiers.take(calls.get(node)!.label ?? node, 'function')]))

  // 只汇合函数结果的分支合并由每一侧的结果写入同一个变量；汇合了其他值的合并没有变量。
  const merged = new Map<string, NodeValue>()
  for (const call of calls.values()) {
    if (call.execKind !== 'join') continue
    const sources = call.args.map(arg => arg.value)
    if (!sources.every(value => value.kind === 'output' && producesVariable(calls.get(value.node)!))) continue
    for (const value of sources) merged.set(valueKey(value), { kind: 'output', node: call.node, port: call.results[0]!.name })
  }
  const holder = <V extends IrValue>(value: V): V | NodeValue => {
    const next = merged.get(valueKey(value))
    return next === undefined ? value : holder(next)
  }
  const read = new Set([
    ...[...calls.values()].filter(call => call.execKind !== 'join').flatMap(call => call.args),
    ...bindingsOf(items),
  ].map(arg => valueKey(holder(arg.value))))
  const variables = new Map<string, { readonly name: string; readonly type: string }>()
  for (const [node, signature] of signatures) {
    for (const result of signature.results) {
      const value = holder<NodeValue>({ kind: 'output', node, port: result.name })
      const key = valueKey(value)
      if (!read.has(key) || variables.has(key)) continue
      const stem = callees.get(value.node) ?? calls.get(value.node)!.label ?? value.node
      variables.set(key, { name: identifiers.take(`${stem}_${value.port}`, 'value'), type: result.type })
    }
  }
  const variableOf = (value: IrValue) => variables.get(valueKey(holder(value)))

  const expression = (call: IrCall): string => {
    const lines = codeLines(call)
    if (lines.length > 1) throw new RenderError({ code: 'multiline-condition', node: call.node })
    return lines[0] ?? ''
  }
  const valueOf = (value: IrValue): string => {
    if (value.kind === 'input') return parameters.get(value.port)!
    const source = calls.get(value.node)!
    if (source.type === CODE_CONDITION_TYPE) return expression(source)
    const variable = variableOf(value)
    if (variable === undefined) throw new RenderError({ code: 'no-value', node: value.node })
    return variable.name
  }
  const invoke = (call: IrCall): string => {
    const signature = signatures.get(call.node)!
    const args = signature.parameters.map((parameter) => {
      const arg = call.args.find(candidate => candidate.port === parameter.name)
      if (arg !== undefined) return valueOf(arg.value)
      if (parameter.optional) return functions!.absent
      throw new RenderError({ code: 'unwired-parameter', node: call.node, port: parameter.name })
    })
    const invocation = `${callees.get(call.node)!}(${args.join(', ')})`
    const targets = signature.results.map(result => variableOf({ kind: 'output', node: call.node, port: result.name })?.name)
    if (targets.every(target => target === undefined)) return invocation
    return fill(functions!.assign, {
      targets: targets.map(target => target ?? functions!.discard).join(', '),
      value: invocation,
    })
  }

  // 生成函数的参数和结果取所连函数参数、结果的类型；没有连到函数的端口按端口类型。
  const parameterType = (port: PortDefinition): string => {
    for (const [node, signature] of signatures) {
      const arg = calls.get(node)!.args.find(candidate => candidate.value.kind === 'input' && candidate.value.port === port.name)
      const parameter = signature.parameters.find(candidate => candidate.name === arg?.port)
      if (parameter !== undefined) return parameter.type
    }
    return functions!.types[port.type]
  }
  const resultType = (port: PortDefinition): string => {
    const binding = bindingsOf(items).find(candidate => candidate.port === port.name)
    return (binding === undefined ? undefined : variableOf(binding.value))?.type ?? functions!.types[port.type]
  }
  const list = (ports: readonly PortDefinition[], names: ReadonlyMap<string, string>, typeOf: (port: PortDefinition) => string): string =>
    ports.map(port => functions === undefined
      ? names.get(port.name)!
      : fill(functions.typed, { name: names.get(port.name)!, type: typeOf(port) })).join(', ')

  return {
    preamble: [
      `${language.comment}Generated from workflow ${JSON.stringify(ir.name)}. Edit the workflow, not this file.`,
      '',
      ...[...signatures].flatMap(([node, signature]) => {
        const code = codeLines(calls.get(node)!).join('\n')
        const text = signature.name === undefined ? fill(functions!.bind, { name: callees.get(node)!, code }) : code
        return [...text.split('\n'), '']
      }),
    ],
    open: fill(language.functionOpen, {
      name,
      parameters: list(ir.inputs, parameters, parameterType),
      results: functions === undefined || ir.outputs.length === 0
        ? ''
        : fill(functions.results, { results: list(ir.outputs, results, resultType) }),
    }),
    prologue: functions === undefined
      ? []
      : [...variables.values()].map(variable => fill(functions.declare, variable)),
    epilogue: functions === undefined || ir.outputs.length === 0 ? [] : [functions.return],
    statement(item) {
      if (item.kind === 'outputs') {
        return functions === undefined
          ? []
          : item.bindings.map(binding => fill(functions.assign, { targets: results.get(binding.port)!, value: valueOf(binding.value) }))
      }
      if (item.type === CODE_BLOCK_TYPE) return codeLines(item)
      if (item.type === CODE_FUNCTION_TYPE) return [invoke(item)]
      // 表达式写进读它的地方；流程控制和边界节点没有代码。
      return []
    },
    condition(gate, pin) {
      if (gate.execKind !== 'decision') throw new RenderError({ code: 'not-a-decision', node: gate.node })
      const source = gate.args[0]
      if (source === undefined) throw new RenderError({ code: 'no-condition', node: gate.node })
      return pin === gate.pins[0] ? valueOf(source.value) : fill(language.negation, { condition: valueOf(source.value) })
    },
  }
}

/** 节点的值会存进变量：函数节点，或分支合并。 */
function producesVariable(call: IrCall): boolean {
  return call.type === CODE_FUNCTION_TYPE || call.execKind === 'join'
}

/** 某个节点产出的值。 */
type NodeValue = Extract<IrValue, { readonly kind: 'output' }>

function valueKey(value: IrValue): string {
  return value.kind === 'input' ? `\u0000${value.port}` : `${value.node}\u0000${value.port}`
}

/** 节点携带的代码按行拆开，去掉首尾空行和整体多出的缩进；空代码没有行。 */
function codeLines(call: IrCall): string[] {
  const lines = codeOf(call.config).replace(/\s+$/, '').split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  const indents = lines.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length)
  const common = Math.min(...indents)
  return lines.map(line => line.slice(common))
}

/** 块树中除条件块外的全部项，按写出的先后排列。 */
function itemsOf(block: IrBlock): (IrCall | IrOutputs)[] {
  return block.flatMap(item => item.kind === 'guard' ? item.arms.flatMap(arm => itemsOf(arm.body)) : [item])
}

function bindingsOf(items: readonly (IrCall | IrOutputs)[]) {
  return items.flatMap(item => item.kind === 'outputs' ? item.bindings : [])
}

/** 替换模板中的 `{键}`；模板中不是这些键的花括号原样保留。 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** 在一个文件内分配互不相同、不是保留字的标识符。 */
class Identifiers {
  private readonly taken = new Set<string>()

  constructor(private readonly reserved: readonly string[]) {}

  /** 占用代码写定的名字。 */
  reserve(name: string): void {
    this.taken.add(name)
  }

  /** `text` 对应的标识符；没有可用字符时用 `fallback` 加序号，重名时加后缀。 */
  take(text: string, fallback: string): string {
    const cleaned = text.replaceAll(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\p{N})/u, '_')
    const base = /^_*$/.test(cleaned) || this.reserved.includes(cleaned) ? `${fallback}${this.taken.size + 1}` : cleaned
    let name = base
    for (let suffix = 2; this.taken.has(name); suffix += 1) name = `${base}_${suffix}`
    this.taken.add(name)
    return name
  }
}

function assertNever(kind: never): never {
  throw new Error(`未覆盖的工作流种类: ${String(kind)}`)
}
