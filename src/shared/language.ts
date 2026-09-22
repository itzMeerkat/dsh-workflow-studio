/**
 * 工作流写成的语言，以及携带这些语言代码的节点。
 *
 * `run` 工作流写成伪代码；`code` 工作流在 {@link DagWorkflowDefinition.language} 中指定一种
 * {@link CODE_LANGUAGES}，它的节点携带的就是该语言的代码。浏览器在每次编辑时读函数签名，
 * 所以语言是本包的代码，而不是由插件注册的数据。
 * @module dsh-workflow-studio
 */

import { goSignature } from './go.ts'
import type { DagNodeDefinition, DagWorkflowDefinition, PortDefinition, PortType } from './types.ts'

/** 代码节点存放代码的配置字段。 */
export const CODE_FIELD = 'code'

/** 一段语句，按它在图中的位置和所属分支原样写出。 */
export const CODE_BLOCK_TYPE = 'code-block'

/** 一行表达式，写进读它的值的地方，例如分支的条件。 */
export const CODE_CONDITION_TYPE = 'code-condition'

/** 一个函数；它的参数和结果就是节点的输入和输出端口。 */
export const CODE_FUNCTION_TYPE = 'code-function'

/** 签名中的一个参数或结果。 */
export interface TypedName {
  readonly name: string
  /** 该语言中的类型。 */
  readonly type: string
  /** 能接收该类型值的端口类型。 */
  readonly port: PortType
  /** 该类型有表示"没有值"的写法，例如 Go 的指针可以是 nil：参数不必接线，结果可能没有值。 */
  readonly optional: boolean
}

/** 函数节点的代码声明的函数。 */
export interface Signature {
  /** 函数自己的名字；匿名函数没有。 */
  readonly name?: string
  readonly parameters: readonly TypedName[]
  readonly results: readonly TypedName[]
}

/**
 * 一种语言如何读和调用函数节点。模板中的 `{键}` 由生成器替换。
 *
 * 生成的函数在开头声明它读的每个函数结果，所以分支里赋的值在分支之后仍然可读。
 */
export interface FunctionSyntax {
  /** 读代码开头的函数；代码不是函数时为 undefined。 */
  readonly signature: (code: string) => Signature | undefined
  /** 每种端口类型的值在该语言中的类型。 */
  readonly types: Readonly<Record<PortType, string>>
  /** 签名中带类型的一项，含 `{name}` 与 `{type}`。 */
  readonly typed: string
  /** 生成函数的结果，接在参数之后，含 `{results}`。 */
  readonly results: string
  /** 在生成函数开头声明一个变量，含 `{name}` 与 `{type}`。 */
  readonly declare: string
  /** 赋值，含 `{targets}` 与 `{value}`。 */
  readonly assign: string
  /** 丢弃一个没有读者的结果时的赋值目标。 */
  readonly discard: string
  /** 可选参数没有接线时传入的值。 */
  readonly absent: string
  /** 在文件顶层给匿名函数一个名字，含 `{name}` 与 `{code}`。 */
  readonly bind: string
  /** 有结果的生成函数的最后一行。 */
  readonly return: string
}

/** 一种语言的写法。模板中的 `{键}` 由生成器替换。 */
export interface Language {
  readonly name: string
  /** 一级缩进。 */
  readonly indent: string
  /** 行注释的前缀，含它与正文之间的空白。 */
  readonly comment: string
  /** 开启生成函数的一行，含 `{name}`、`{parameters}`，声明结果的语言另含 `{results}`。 */
  readonly functionOpen: string
  /** 开启条件块的一行，含 `{condition}`。 */
  readonly conditionOpen: string
  /** 开启同一条件另一侧的一行；用 {@link blockEnd} 闭合块的语言在这一行闭合上一侧。 */
  readonly otherwiseOpen: string
  /** 条件取反的表达式，含 `{condition}`。 */
  readonly negation: string
  /** 闭合函数或条件块的一行；靠缩进闭合块的语言没有。 */
  readonly blockEnd?: string
  /** 空块中必须写的一行；允许空块的语言没有。 */
  readonly emptyBlock?: string
  /** 不能作为标识符的词。 */
  readonly reserved: readonly string[]
  /** 函数节点的读法和调用法；没有它的语言不能容纳函数节点。 */
  readonly functions?: FunctionSyntax
}

/** `run` 工作流的语言：按执行顺序缩进的伪代码。 */
export const PSEUDOCODE: Language = {
  name: 'pseudocode',
  indent: '  ',
  comment: '# ',
  functionOpen: 'workflow {name}({parameters}):',
  conditionOpen: 'if {condition}:',
  otherwiseOpen: 'else:',
  negation: 'not {condition}',
  reserved: [],
}

/** Python 3。 */
export const PYTHON: Language = {
  name: 'python',
  indent: '    ',
  comment: '# ',
  functionOpen: 'def {name}({parameters}):',
  conditionOpen: 'if {condition}:',
  otherwiseOpen: 'else:',
  negation: 'not ({condition})',
  emptyBlock: 'pass',
  reserved: [
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
    'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
    'with', 'yield',
  ],
}

/** TypeScript。 */
export const TYPESCRIPT: Language = {
  name: 'typescript',
  indent: '  ',
  comment: '// ',
  functionOpen: 'export function {name}({parameters}) {',
  conditionOpen: 'if ({condition}) {',
  otherwiseOpen: '} else {',
  negation: '!({condition})',
  blockEnd: '}',
  reserved: [
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this',
    'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  ],
}

/** Go；函数节点的代码是具名函数或函数字面量。 */
export const GO: Language = {
  name: 'go',
  indent: '\t',
  comment: '// ',
  functionOpen: 'func {name}({parameters}){results} {',
  conditionOpen: 'if {condition} {',
  otherwiseOpen: '} else {',
  negation: '!({condition})',
  blockEnd: '}',
  reserved: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
    'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
    'struct', 'switch', 'type', 'var',
  ],
  functions: {
    signature: goSignature,
    types: { number: 'float64', string: 'string', boolean: 'bool', any: 'any' },
    typed: '{name} {type}',
    results: ' ({results})',
    declare: 'var {name} {type}',
    assign: '{targets} = {value}',
    discard: '_',
    absent: 'nil',
    bind: 'var {name} = {code}',
    return: 'return',
  },
}

/** `code` 工作流可以使用的语言。 */
export const CODE_LANGUAGES: readonly Language[] = [PYTHON, TYPESCRIPT, GO]

/**
 * 一个工作流写成的语言。
 * @param definition - 工作流定义。
 * @returns `run` 工作流为伪代码，`code` 工作流为它指定的语言。
 * @throws `code` 工作流没有指定 {@link CODE_LANGUAGES} 之一时。
 */
export function languageOf(definition: Pick<DagWorkflowDefinition, 'kind' | 'language'>): Language {
  switch (definition.kind) {
    case 'run':
      return PSEUDOCODE
    case 'code': {
      const language = CODE_LANGUAGES.find(candidate => candidate.name === definition.language)
      if (language !== undefined) return language
      throw new Error(`code 工作流的语言必须是 ${CODE_LANGUAGES.map(({ name }) => name).join('、')} 之一，`
        + `而不是 ${definition.language ?? '空'}`)
    }
    default:
      return assertNever(definition.kind)
  }
}

/**
 * 节点携带的代码。
 * @param config - 节点配置。
 */
export function codeOf(config: Readonly<Record<string, unknown>>): string {
  return String(config[CODE_FIELD] ?? '')
}

/**
 * 按代码重读每个函数节点的端口，并去掉接在它已不再声明的端口上的数据边。
 *
 * 代码读不出函数时（例如正在输入签名）保留节点原有的端口，接线不因一次按键而丢失。
 * @param definition - 工作流定义。
 * @returns 端口与代码一致的定义；语言不能容纳函数节点时原样返回。
 */
export function withSignatures(definition: DagWorkflowDefinition): DagWorkflowDefinition {
  const functions = languageOf(definition).functions
  if (functions === undefined) return definition
  const nodes = definition.nodes.map((node) => {
    const signature = node.type === CODE_FUNCTION_TYPE ? functions.signature(codeOf(node.config)) : undefined
    return signature === undefined
      ? node
      : { ...node, inputs: signature.parameters.map(portOf), outputs: signature.results.map(portOf) }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const declares = (node: DagNodeDefinition, ports: DagNodeDefinition['inputs'], port: string): boolean =>
    node.type !== CODE_FUNCTION_TYPE || (ports ?? []).some(candidate => candidate.name === port)
  return {
    ...definition,
    nodes,
    edges: definition.edges.filter((edge) => {
      if (edge.kind === 'exec') return true
      const source = byId.get(edge.source)!
      const target = byId.get(edge.target)!
      return declares(source, source.outputs, edge.sourcePort ?? 'output')
        && declares(target, target.inputs, edge.targetPort ?? 'input')
    }),
  }
}

function portOf({ name, port, optional }: TypedName): PortDefinition {
  return optional ? { name, type: port, required: false } : { name, type: port }
}

function assertNever(kind: never): never {
  throw new Error(`未覆盖的工作流种类: ${String(kind)}`)
}
