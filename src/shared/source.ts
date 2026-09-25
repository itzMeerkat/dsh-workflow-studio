/**
 * 把工作流的 IR 写成它的语言的源码。
 *
 * 伪代码和代码生成是同一次遍历：IR 定好了顺序和条件块，{@link Language} 决定块怎么开合、
 * 函数怎么声明、条件怎么取反；工作流的种类决定一项写成什么：`run` 工作流的节点写成对节点类型的调用，
 * `code` 工作流的节点携带代码或调用原子目录中的函数。
 * @module dsh-workflow-studio
 */

import { NO_CALLEES, type Callees } from './callees.ts'
import type { IrBlock, IrCall, IrGuard, IrOutputs, IrValue, WorkflowIr } from './ir.ts'
import {
  CODE_ATOM_TYPE, CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, atomOf, codeOf, typeName, type Atom, type Language, type Signature,
} from './language.ts'
import { SUBWORKFLOW_TYPE, subworkflowOf, workflowSignature } from './subworkflow.ts'
import { SWITCH_DEFAULT_PIN, SWITCH_TYPE, switchCases } from './switch.ts'
import type { NodeId, PortDefinition, PortType } from './types.ts'

/** 一种语言写不出的图，`node` 是需要修改的节点。 */
export type RenderFault =
  /** 条件块的守卫节点不是决策节点，它的引脚不对应任何表达式。 */
  | { readonly code: 'not-a-decision'; readonly node: NodeId }
  /** 决策节点的条件输入没有接线。 */
  | { readonly code: 'no-condition'; readonly node: NodeId }
  /** 作为条件的代码不止一行。 */
  | { readonly code: 'multiline-condition'; readonly node: NodeId }
  /** 原子节点引用的文件不在原子目录中，或不能作为原子。 */
  | { readonly code: 'missing-atom'; readonly node: NodeId; readonly atom: string }
  /** 子工作流节点嵌入的工作流不存在，或所在语言写不出函数调用。 */
  | { readonly code: 'missing-workflow'; readonly node: NodeId; readonly workflow: string }
  /** 原子的必需参数 `port` 没有接线。 */
  | { readonly code: 'unwired-parameter'; readonly node: NodeId; readonly port: string }
  /** 生成的代码中没有保存这个节点产出的值：它既不是调用的结果，也不是只汇合调用结果的分支合并。 */
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
 * @param callees - 工作流的节点能调用的原子和工作流。
 * @returns 源码，以一个换行结尾。
 * @throws {@link RenderError} 图中有该语言写不出的结构时。
 */
export function renderWorkflow(ir: WorkflowIr, language: Language, callees: Callees = NO_CALLEES): string {
  const content = contentOf(ir, language, callees)
  const line = (depth: number, text: string): string => text === '' ? '' : `${language.indent.repeat(depth)}${text}`
  const close = (depth: number): string[] => language.blockEnd === undefined ? [] : [line(depth, language.blockEnd)]
  const block = (items: IrBlock, depth: number): string[] => {
    const lines = items.flatMap(item => item.kind === 'guard'
      ? guard(item, depth)
      : content.statement(item).map(text => line(depth, text)))
    return lines.length > 0 || language.emptyBlock === undefined ? lines : [line(depth, language.emptyBlock)]
  }
  // 另一侧的开启行自带上一侧的闭合（例如 `} else {`），所以块只在最后一侧之后闭合。
  // arm 覆盖了决策节点的每个引脚时，最后一侧不必写条件。
  const armOpen = (item: IrGuard, index: number): string => {
    if (index > 0 && index === item.arms.length - 1 && item.arms.length === item.gate.pins.length) return language.otherwiseOpen
    const condition = content.condition(item.gate, item.arms[index]!.pin)
    return fill(index === 0 ? language.conditionOpen : language.otherwiseIfOpen, { condition })
  }
  const guard = (item: IrGuard, depth: number): string[] => [
    ...item.arms.flatMap((arm, index) => [line(depth, armOpen(item, index)), ...block(arm.body, depth + 1)]),
    ...close(depth),
  ]

  const body = [
    content.open,
    ...content.prologue.map(text => line(1, text)),
    ...block(ir.body, 1),
    ...content.epilogue.map(text => line(1, text)),
    ...close(0),
  ]
  return [...content.preamble(body), ...body].join('\n') + '\n'
}

/** 一种工作流的节点写成什么。 */
interface Content {
  /** 生成函数之前的行，按写好的函数决定，例如只导入函数用到的包。 */
  preamble(body: readonly string[]): readonly string[]
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

function contentOf(ir: WorkflowIr, language: Language, callees: Callees): Content {
  switch (ir.kind) {
    case 'run':
      return runContent(ir, language, callees)
    case 'code':
      return codeContent(ir, language, callees)
    default:
      return assertNever(ir.kind)
  }
}

/**
 * `run` 工作流：每个节点写成对它类型的一次调用，子工作流写成对它嵌入的工作流的调用；实参按端口写出来源，
 * 条件写成 `节点.引脚`。
 *
 * 作者写的标签是可读的名字，但它不唯一；同名的节点一律退回节点 ID，引用才指向唯一一个节点。
 */
function runContent(ir: WorkflowIr, language: Language, callees: Callees): Content {
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
  const callName = (call: IrCall): string => {
    const embedded = call.type === SUBWORKFLOW_TYPE ? callees.workflows.get(subworkflowOf(call.config)) : undefined
    return embedded === undefined ? call.type : embedded.name.replace(/\s+/g, '_')
  }

  const write = (value: IrValue): string => {
    if (value.kind === 'input') return parameters.get(value.port)!
    // 多输出节点的值按端口区分，单输出节点直接用节点的名字。
    return results.get(value.node)! > 1 ? `${names.get(value.node)!}.${value.port}` : names.get(value.node)!
  }
  return {
    preamble: () => [],
    open: fill(language.functionOpen, { name, parameters: [...parameters.values()].join(', '), results: '' }),
    prologue: [],
    epilogue: [],
    statement(item) {
      if (item.kind === 'outputs') {
        // 输出端口收到的值就是工作流交付的值，因此写成赋值而不是实参。
        return [`out: ${item.bindings.map(binding => `${binding.port} = ${write(binding.value)}`).join(', ')}`]
      }
      const call = `${callName(item)}(${item.args.map(arg => `${arg.port}: ${write(arg.value)}`).join(', ')})`
      const name = names.get(item.node)!
      if (item.results.length > 0) return [`${name} = ${call}`]
      // 没有输出的节点不产生值，但条件块按名字引用它，所以名字与类型不同时仍要写出来。
      return [name === item.type ? call : `${name}: ${call}`]
    },
    condition: (gate, pin) => `${names.get(gate.node)!}.${pin}`,
  }
}

/**
 * `code` 工作流：节点携带的代码按类型写出，编译器只读原子和子工作流的签名，不解析其余代码。
 *
 * 语句节点的代码按所在的块重新缩进后原样写出；表达式节点写进读它的值的地方；原子节点在图中的位置调用
 * 原子目录中的函数，子工作流节点调用它嵌入的工作流生成的函数，实参按参数名取自数据边；
 * 函数的参数、结果和变量按端口类型写出类型。生成的函数与原子同属一个包，所以只写它自己：
 * 包声明取自原子目录，导入只含函数中用到包名的那些原子导入。函数的结果只有被读时才存进变量，
 * 这些变量在函数体开头声明；分支合并不产生代码，汇合到它的结果直接存进它的变量。决策节点按它的第一个输入决定：
 * 条件分支的第一个引脚是条件成立的一侧，另一个是它的取反；多路分支的 case 引脚是值等于该 case，`default` 是
 * 不等于任何 case。case 按值的类型写成字面量：字符串类型加引号，其他类型原样写出，因此 Go 中可以写常量名。
 */
function codeContent(ir: WorkflowIr, language: Language, callees: Callees): Content {
  const functions = language.functions
  const library = callees.atoms
  const identifiers = functionIdentifiers(language, library)
  const name = identifiers.take(ir.name, 'workflow')
  const items = itemsOf(ir.body)
  const calls = new Map(items.flatMap(item => item.kind === 'call' ? [[item.node, item] as const] : []))

  const signatures = new Map<NodeId, Callable>()
  for (const call of calls.values()) {
    const callable = callableOf(call, language, callees)
    if (callable === undefined) continue
    signatures.set(call.node, callable)
    // 被调用的工作流也是包里的函数，局部变量不能遮住它。
    identifiers.reserve(callable.name)
  }
  const parameters = new Map(ir.inputs.map(port => [port.name, identifiers.take(port.name, 'arg')]))
  const results = new Map(ir.outputs.map(port => [port.name, identifiers.take(port.name, 'result')]))

  // 只汇合原子结果的分支合并由每一侧的结果写入同一个变量；汇合了其他值的合并没有变量。
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
      const stem = signatures.get(value.node)?.name ?? calls.get(value.node)!.label ?? value.node
      variables.set(key, { name: identifiers.take(`${stem}_${value.port}`, 'value'), type: typeName(language, result.type) })
    }
  }
  const variableOf = (value: IrValue) => variables.get(valueKey(holder(value)))
  const typeOf = (value: IrValue): PortType => value.kind === 'input'
    ? ir.inputs.find(port => port.name === value.port)!.type
    : signatures.get(value.node)?.results.find(result => result.name === value.port)?.type ?? 'any'

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
  const invoke = (call: IrCall, signature: Callable): string => {
    const args = signature.parameters.map((parameter) => {
      const arg = call.args.find(candidate => candidate.port === parameter.name)
      if (arg !== undefined) return valueOf(arg.value)
      if (parameter.optional) return functions!.absent
      throw new RenderError({ code: 'unwired-parameter', node: call.node, port: parameter.name })
    })
    const invocation = `${signature.name}(${args.join(', ')})`
    const targets = signature.results.map(result => variableOf({ kind: 'output', node: call.node, port: result.name })?.name)
    if (targets.every(target => target === undefined)) return invocation
    return fill(functions!.assign, {
      targets: targets.map(target => target ?? functions!.discard).join(', '),
      value: invocation,
    })
  }

  const list = (ports: readonly PortDefinition[], names: ReadonlyMap<string, string>): string =>
    ports.map(port => functions === undefined
      ? names.get(port.name)!
      : fill(functions.typed, { name: names.get(port.name)!, type: typeName(language, port.type) })).join(', ')

  const syntax = functions?.atoms
  const folder = [...library.values()]
  return {
    preamble(body) {
      const text = body.join('\n')
      // 函数只导入它写到的包；原子里的导入如果函数用不到，写进来 Go 会拒绝编译。
      const imports = [...new Set(folder.flatMap(atom => atom.imports))].sort().filter((spec) => {
        const used = syntax!.importName(spec)
        return used !== undefined && new RegExp(`(?<![\\p{L}\\p{N}_.])${used}\\.`, 'u').test(text)
      })
      return [
        header(language, ir),
        '',
        ...folder.length === 0 ? [] : [fill(syntax!.package, { name: folder[0]!.package }), ''],
        ...imports.length === 0
          ? []
          : [syntax!.importOpen, ...imports.map(spec => `${language.indent}${spec}`), syntax!.importClose, ''],
      ]
    },
    open: fill(language.functionOpen, {
      name,
      parameters: list(ir.inputs, parameters),
      results: functions === undefined || ir.outputs.length === 0
        ? ''
        : fill(functions.results, { results: list(ir.outputs, results) }),
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
      const signature = signatures.get(item.node)
      if (signature !== undefined) return [invoke(item, signature)]
      // 表达式写进读它的地方；流程控制和边界节点没有代码。
      return []
    },
    condition(gate, pin) {
      if (gate.execKind !== 'decision') throw new RenderError({ code: 'not-a-decision', node: gate.node })
      const source = gate.args[0]
      if (source === undefined) throw new RenderError({ code: 'no-condition', node: gate.node })
      if (gate.type === SWITCH_TYPE) return switchCondition(switchCases(gate.config), pin, valueOf(source.value), typeOf(source.value), language)
      return pin === gate.pins[0] ? valueOf(source.value) : fill(language.negation, { condition: valueOf(source.value) })
    },
  }
}

/**
 * 多路分支触发 `pin` 的条件：值等于该 case；`default` 引脚是值不等于任何 case。
 * @param cases - 节点的 case。
 * @param pin - 触发的引脚。
 * @param value - 值的表达式。
 * @param type - 值的类型，决定 case 写成什么字面量。
 * @param language - 工作流的语言。
 */
function switchCondition(cases: readonly string[], pin: string, value: string, type: PortType, language: Language): string {
  const equals = (item: string): string => fill(language.equality, { left: value, right: caseLiteral(item, type) })
  return pin === SWITCH_DEFAULT_PIN
    ? fill(language.negation, { condition: cases.map(equals).join(language.or) })
    : equals(pin)
}

/** case 的字面量：字符串加引号，数字和布尔值原样；类型未知时按文本像什么写，其他类型原样写出。 */
function caseLiteral(item: string, type: PortType): string {
  if (type === 'string') return JSON.stringify(item)
  if (type === 'any' && !/^(true|false|-?\d+(\.\d+)?)$/.test(item)) return JSON.stringify(item)
  return item
}

/** 生成文件的第一行；Go 的工具按 `Code generated … DO NOT EDIT.` 认出生成的文件。 */
function header(language: Language, ir: WorkflowIr): string {
  return `${language.comment}Code generated from workflow ${JSON.stringify(ir.name)}. DO NOT EDIT.`
}

/** 一次调用写出的函数名和签名。 */
type Callable = Signature & { readonly name: string }

/**
 * 调用节点在 `code` 工作流中调用的函数：原子按它的名字，子工作流按它嵌入的工作流生成的函数名。
 * @returns 调用；节点不调用别处时为 undefined。
 * @throws {@link RenderError} 被调用者不存在，或语言写不出调用时。
 */
function callableOf(call: IrCall, language: Language, callees: Callees): Callable | undefined {
  const callable = language.functions !== undefined
  switch (call.type) {
    case CODE_ATOM_TYPE: {
      const atom = language.functions?.atoms === undefined ? undefined : callees.atoms.get(atomOf(call.config))
      if (atom === undefined) throw new RenderError({ code: 'missing-atom', node: call.node, atom: atomOf(call.config) })
      return atom.signature
    }
    case SUBWORKFLOW_TYPE: {
      const workflow = callable ? callees.workflows.get(subworkflowOf(call.config)) : undefined
      if (workflow === undefined) {
        throw new RenderError({ code: 'missing-workflow', node: call.node, workflow: subworkflowOf(call.config) })
      }
      return { ...workflowSignature(workflow), name: workflowFunctionName(workflow.name, language, callees.atoms) }
    }
    default:
      return undefined
  }
}

/**
 * 一个 `code` 工作流生成的函数的名字。
 *
 * 嵌入它的工作流按这个名字调用它，所以名字只取决于工作流名称、语言和它们共用的原子目录。
 * @param name - 工作流名称。
 * @param language - 工作流的语言。
 * @param atoms - 工作流原子目录中的原子。
 * @returns 该语言中的标识符。
 */
export function workflowFunctionName(name: string, language: Language, atoms: ReadonlyMap<string, Atom>): string {
  return functionIdentifiers(language, atoms).take(name, 'workflow')
}

/** 生成的函数所在的文件的标识符：原子与生成的函数同在一个包，所以包里每个原子的名字都已被占用。 */
function functionIdentifiers(language: Language, atoms: ReadonlyMap<string, Atom>): Identifiers {
  const identifiers = new Identifiers(language.reserved)
  for (const atom of atoms.values()) identifiers.reserve(atom.signature.name)
  return identifiers
}

/** 节点的值会存进变量：调用节点，或分支合并。 */
function producesVariable(call: IrCall): boolean {
  return call.type === CODE_ATOM_TYPE || call.type === SUBWORKFLOW_TYPE || call.execKind === 'join'
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
