/**
 * 工作流写成的语言，以及携带这些语言代码的节点。
 *
 * `run` 工作流写成伪代码；`code` 工作流在 {@link DagWorkflowDefinition.language} 中指定一种
 * {@link CODE_LANGUAGES}，它的节点携带的就是该语言的代码，或调用它的原子目录中的函数。浏览器读原子的签名
 * 来画节点的端口，所以语言是本包的代码，而不是由插件注册的数据。
 * @module dsh-workflow-studio
 */

import { GO_TYPES, goAtom, goImportName, goPackage } from './go.ts'
import { BUILTIN_PORT_TYPES, type BuiltinPortType, type DagWorkflowDefinition, type PortDefinition, type PortType } from './types.ts'
import { assertNever } from './errors.ts'
import { refuse } from './refusal.ts'

/** 代码节点存放代码的配置字段。 */
export const CODE_FIELD = 'code'

/** 一段语句，按它在图中的位置和所属分支原样写出。 */
export const CODE_BLOCK_TYPE = 'code-block'

/** 一行表达式，写进读它的值的地方，例如分支的条件。 */
export const CODE_CONDITION_TYPE = 'code-condition'

/** 工作流原子目录中的一个原子；节点只记下文件名，代码和端口随目录更新。 */
export const CODE_ATOM_TYPE = 'code-atom'

/** 原子节点存放原子文件名的配置字段。 */
export const ATOM_FIELD = 'atom'

/** 签名中的一个结果，也是参数共有的部分。 */
export interface TypedName {
  readonly name: string
  /** 端口类型，即该语言中的类型；见 {@link PortType}。 */
  readonly type: PortType
}

/** 签名中的一个参数。 */
export interface Parameter extends TypedName {
  /** 参数的类型有表示"没有值"的写法，例如 Go 的指针可以是 nil，所以它不必接线。 */
  readonly optional: boolean
}

/** 一个函数声明的参数和结果。 */
export interface Signature {
  /** 函数自己的名字；匿名函数没有。 */
  readonly name?: string
  readonly parameters: readonly Parameter[]
  /** 调用产生的值，不含它返回的错误。 */
  readonly results: readonly TypedName[]
  /** 调用可能失败：它另外返回一个错误，工作流遇到错误即提前返回，所以这个错误不是结果端口。 */
  readonly fails: boolean
}

/**
 * 原子：原子目录中的一个文件，恰好导出一个函数；文件中的其余声明只供这个函数使用。
 *
 * 目录里的文件同属一个包，生成的工作流函数也写进这个包，所以它按名字调用原子，不必复制它们。
 */
export interface Atom {
  /** 目录中的文件名，也是原子的 ID。 */
  readonly file: string
  /** 导入项，按原文，例如 `"fmt"` 或 `str "strings"`。 */
  readonly imports: readonly string[]
  /** 导出函数的签名；调用按名字进行。 */
  readonly signature: Signature & { readonly name: string }
}

/** 一个不能作为原子的文件。 */
export type AtomFault =
  /** 没有导出函数。 */
  | { readonly file: string; readonly fault: 'no-exported-function' }
  /** 导出了不止一个函数，`names` 是它们的名字。 */
  | { readonly file: string; readonly fault: 'several-exported-functions'; readonly names: readonly string[] }
  /** 读不出导出函数的签名。 */
  | { readonly file: string; readonly fault: 'unreadable-signature' }

/** 从原子目录读出的一个文件。 */
export interface AtomFile {
  readonly file: string
  readonly text: string
}

/** 一个原子目录读出的全部原子，按文件名索引；不能作为原子的文件单列。 */
export interface AtomLibrary {
  readonly atoms: ReadonlyMap<string, Atom>
  readonly faults: readonly AtomFault[]
  /** 目录中有没有 {@link AtomSyntax.types} 文件。 */
  readonly types: boolean
  /** 目录的包，生成的函数写进这个包：取自声明了包的第一个文件；还没有这样的文件时取目录名，不能作标识符的字符换成 `_`。 */
  readonly package: string
}

/** 一种语言如何读原子目录，以及把生成的函数写进原子所在的包。 */
export interface AtomSyntax {
  /** 原子文件的扩展名，含点。 */
  readonly extension: string
  /** 生成的函数写进原子目录时的文件名后缀，前接工作流 ID，例如 `checkout.workflow.go`；这些文件不是原子。 */
  readonly outputSuffix: string
  /** 声明原子所用自定义类型的文件的文件名；它不是原子，内容不被解析，目录中可以没有它。 */
  readonly types: string
  /** 一个导入项在代码中的包名；空白导入和点导入没有。 */
  readonly importName: (spec: string) => string | undefined
  /** 读一个原子文件。 */
  readonly read: (file: string, text: string) => Atom | AtomFault
  /** 一个文件声明的包名；没有包声明时为 undefined。 */
  readonly packageOf: (text: string) => string | undefined
  /** 包声明，含 `{name}`。 */
  readonly package: string
  /** 导入块的第一行；导入项在块内缩进一级。 */
  readonly importOpen: string
  /** 导入块的最后一行。 */
  readonly importClose: string
}

/**
 * 一种语言如何调用原子并声明生成的函数。模板中的 `{键}` 由生成器替换。
 *
 * 生成的函数在开头声明它读的每个原子结果，所以分支里赋的值在分支之后仍然可读。
 */
export interface FunctionSyntax {
  /** 每种内置端口类型在该语言中的类型；其余端口类型本身就是该语言的类型。 */
  readonly types: Readonly<Record<BuiltinPortType, string>>
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
  /** 生成函数的最后一行。 */
  readonly return: string
  /** 生成函数的最后一个结果：它返回的错误；没有调用失败时为零值。 */
  readonly error: { readonly name: string; readonly type: string }
  /**
   * 可能失败的调用之后的行：调用失败时把错误加上 `{step}`（调用的名字）后提前返回。含 `{error}` 与 `{step}`，
   * 用到的导入项是 {@link exitImport}。
   */
  readonly exit: readonly string[]
  /** {@link exit} 用到的导入项，只在生成的函数用到它时导入。 */
  readonly exitImport: string
  /** 原子目录的读法。 */
  readonly atoms: AtomSyntax
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
  /** 开启同一条件最后一侧的一行；用 {@link blockEnd} 闭合块的语言在这一行闭合上一侧。 */
  readonly otherwiseOpen: string
  /** 开启同一决策节点另一个引脚一侧的一行，含 `{condition}`；闭合上一侧同 {@link otherwiseOpen}。 */
  readonly otherwiseIfOpen: string
  /** 闭合函数或条件块的一行；靠缩进闭合块的语言没有。 */
  readonly blockEnd?: string
  /** 不能作为标识符的词。 */
  readonly reserved: readonly string[]
  /** 原子的读法和调用法；只有 `code` 工作流的语言有。 */
  readonly functions?: FunctionSyntax
}

/** `code` 工作流的语言：它另外写得出条件取反、switch 语句和函数调用。 */
export interface CodeLanguage extends Language {
  /** 条件取反的表达式，含 `{condition}`。 */
  readonly negation: string
  /** 多路分支写成的 switch 语句，`open` 含 `{value}`，`case` 含逗号分隔的 `{values}`，语句由 {@link blockEnd} 闭合。 */
  readonly switch: { readonly open: string; readonly case: string; readonly default: string }
  readonly functions: FunctionSyntax
}

/** `run` 工作流的语言：按执行顺序缩进的伪代码。 */
export const PSEUDOCODE: Language = {
  name: 'pseudocode',
  indent: '  ',
  comment: '# ',
  functionOpen: 'workflow {name}({parameters}):',
  conditionOpen: 'if {condition}:',
  otherwiseOpen: 'else:',
  otherwiseIfOpen: 'else if {condition}:',
  reserved: [],
}

/** Go；原子目录是一个 Go 包，每个文件导出一个具名函数或绑定到 `var` 的函数字面量，自定义类型声明在 `types.go`。 */
export const GO: CodeLanguage = {
  name: 'go',
  indent: '\t',
  comment: '// ',
  functionOpen: 'func {name}({parameters}){results} {',
  conditionOpen: 'if {condition} {',
  otherwiseOpen: '} else {',
  otherwiseIfOpen: '} else if {condition} {',
  negation: '!({condition})',
  switch: { open: 'switch {value} {', case: 'case {values}:', default: 'default:' },
  blockEnd: '}',
  reserved: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
    'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
    'struct', 'switch', 'type', 'var',
  ],
  functions: {
    types: GO_TYPES,
    typed: '{name} {type}',
    results: ' ({results})',
    declare: 'var {name} {type}',
    assign: '{targets} = {value}',
    discard: '_',
    absent: 'nil',
    return: 'return',
    error: { name: 'err', type: 'error' },
    exit: ['if {error} != nil {', '\t{error} = fmt.Errorf({step}, {error})', '\treturn', '}'],
    exitImport: '"fmt"',
    atoms: {
      extension: '.go',
      outputSuffix: '.workflow.go',
      types: 'types.go',
      importName: goImportName,
      read: goAtom,
      packageOf: goPackage,
      package: 'package {name}',
      importOpen: 'import (',
      importClose: ')',
    },
  },
}

/** `code` 工作流可以使用的语言；新的 `code` 工作流用第一种。 */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [GO]

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
    case 'code':
      return codeLanguageOf(definition.language)
    default:
      return assertNever(definition.kind)
  }
}

/**
 * 名为 `name` 的 `code` 工作流语言。
 * @param name - 语言名。
 * @throws `name` 不是 {@link CODE_LANGUAGES} 之一时。
 */
export function codeLanguageOf(name: string | undefined): CodeLanguage {
  const language = CODE_LANGUAGES.find(candidate => candidate.name === name)
  if (language !== undefined) return language
  return refuse({ code: 'language-unknown', language: name ?? '', languages: CODE_LANGUAGES.map(candidate => candidate.name) })
}

/**
 * 代码节点由作者声明端口的那几侧：代码块的输入和输出，代码条件的输入，它的输出固定是条件的值。
 * @param type - 节点类型。
 * @returns 作者声明端口的各侧；其他节点的端口由类型或被调用者决定，没有这样的一侧。
 */
export function codePortSides(type: string): readonly ('inputs' | 'outputs')[] {
  switch (type) {
    case CODE_BLOCK_TYPE:
      return ['inputs', 'outputs']
    case CODE_CONDITION_TYPE:
      return ['inputs']
    default:
      return []
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
 * 原子节点引用的原子文件名。
 * @param config - 节点配置。
 */
export function atomOf(config: Readonly<Record<string, unknown>>): string {
  return String(config[ATOM_FIELD] ?? '')
}

/**
 * 端口类型在一种语言中的写法。
 * @param language - 工作流的语言。
 * @param type - 端口类型。
 * @returns 内置端口类型在该语言中的类型；没有类型的语言和其余端口类型原样返回。
 */
export function typeName(language: Language, type: PortType): string {
  const types = language.functions?.types
  return types !== undefined && Object.hasOwn(types, type) ? types[type as BuiltinPortType] : type
}

/**
 * 目录中的一个文件是不是原子文件。
 * @param file - 文件名。
 * @param syntax - 语言的原子读法。
 * @returns 该语言扩展名的文件为 true，但测试文件、生成的工作流文件和类型文件不是原子文件。
 */
export function isAtomFile(file: string, syntax: AtomSyntax): boolean {
  return file.endsWith(syntax.extension) && !file.endsWith(`_test${syntax.extension}`)
    && !file.endsWith(syntax.outputSuffix) && file !== syntax.types
}

/**
 * 读出一个原子目录中的原子。
 * @param folder - 目录的路径。
 * @param files - 目录中该语言扩展名的文件，含 {@link AtomSyntax.types} 文件。
 * @param syntax - 语言的原子读法。
 * @returns 按文件名索引的原子、不能作为原子的文件、有没有类型文件，以及目录的包。
 */
export function atomLibrary(folder: string, files: readonly AtomFile[], syntax: AtomSyntax): AtomLibrary {
  const read = files.filter(({ file }) => isAtomFile(file, syntax)).map(({ file, text }) => syntax.read(file, text))
  const declared = files.map(({ text }) => syntax.packageOf(text)).find(name => name !== undefined)
  return {
    atoms: new Map(read.flatMap(atom => 'fault' in atom ? [] : [[atom.file, atom] as const])),
    faults: read.filter(atom => 'fault' in atom),
    types: files.some(({ file }) => file === syntax.types),
    package: declared ?? folder.split(/[\\/]/).at(-1)!.replaceAll(/[^\p{L}\p{N}_]/gu, '_').replace(/^(?=\p{N})/u, '_'),
  }
}

/**
 * 端口可以声明的类型：内置类型，其后是原子的参数和结果用到的其他类型，排序。
 * @param atoms - 原子目录读出的原子。
 */
export function portTypes(atoms: ReadonlyMap<string, Atom>): PortType[] {
  const used = [...atoms.values()].flatMap(({ signature }) => [...signature.parameters, ...signature.results]).map(({ type }) => type)
  return [...BUILTIN_PORT_TYPES, ...[...new Set(used)].filter(type => !BUILTIN_PORT_TYPES.includes(type as BuiltinPortType)).sort()]
}

/**
 * 签名对应的端口。
 * @param names - 签名中的参数或结果。
 */
export function signaturePorts(names: readonly (TypedName & { readonly optional?: boolean })[]): PortDefinition[] {
  return names.map(({ name, type, optional }) => optional === true ? { name, type, required: false } : { name, type })
}
