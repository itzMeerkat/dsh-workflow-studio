/**
 * 读 Go 代码：原子文件的顶层声明、函数的签名，以及导入项的包名。
 *
 * 签名只读到函数体的左花括号为止，因此代码可以是具名函数，也可以是函数字面量（闭包）；
 * 不支持方法接收者和类型参数。
 * @module dsh-workflow-studio
 */

import type { Atom, AtomFault, Signature, TypedName } from './language.ts'
import type { PortType } from './types.ts'

/** 开头即是类型的关键字：`chan int` 是一个类型，而不是名为 `chan` 的参数。 */
const TYPE_KEYWORDS = new Set(['chan', 'func', 'interface', 'map', 'struct'])

/**
 * 一段 Go 代码开头的函数的签名。
 * @param code - 以函数声明或函数字面量开头的代码。
 * @returns 签名；代码不以函数开头或括号不配对时为 undefined。
 */
export function goSignature(code: string): Signature | undefined {
  const header = /^\s*func\s*([\p{L}_][\p{L}\p{N}_]*)?\s*\(/u.exec(code)
  if (header === null) return undefined
  const open = header[0].length - 1
  const close = closing(code, open)
  const body = close === undefined ? undefined : bodyStart(code, close + 1)
  if (close === undefined || body === undefined) return undefined
  const results = code.slice(close + 1, body).trim()
  return {
    ...(header[1] === undefined ? {} : { name: header[1] }),
    parameters: entries(code.slice(open + 1, close), 'input'),
    results: results.startsWith('(') ? entries(results.slice(1, -1), 'output') : entries(results, 'output'),
  }
}

/**
 * 参数或结果列表中的每一项。
 *
 * Go 的列表要么每项都有名字，要么都没有；`a, b int` 中没写类型的名字取其后第一个类型。
 * 没有名字的项按位置命名为 `fallback`、或 `fallback1`、`fallback2`……
 */
function entries(list: string, fallback: string): TypedName[] {
  const items = split(list)
  const pairs = items.map(item => /^([\p{L}_][\p{L}\p{N}_]*)\s+(\S.*)$/su.exec(item))
  if (!pairs.some(pair => pair !== null && !TYPE_KEYWORDS.has(pair[1]!))) {
    return items.map((type, index) => typed(items.length === 1 ? fallback : `${fallback}${index + 1}`, type))
  }
  const named: TypedName[] = []
  let pending: string[] = []
  pairs.forEach((pair, index) => {
    if (pair === null) {
      pending.push(items[index]!)
      return
    }
    for (const name of [...pending, pair[1]!]) named.push(typed(name, pair[2]!))
    pending = []
  })
  return named
}

/** 指针可以是 nil，所以指针参数不必接线，指针结果也可能没有值。 */
function typed(name: string, type: string): TypedName {
  const pointer = type.startsWith('*')
  return { name, type, port: portType(pointer ? type.slice(1) : type), optional: pointer }
}

/** Go 类型对应的端口类型；其余类型都能接任何值。 */
function portType(type: string): PortType {
  if (type === 'bool') return 'boolean'
  if (type === 'string') return 'string'
  return /^(?:u?int(?:8|16|32|64)?|uintptr|float(?:32|64)|byte|rune)$/.test(type) ? 'number' : 'any'
}

/** 按不在括号内的逗号拆开，去掉空项。 */
function split(list: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index]!
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ',' && depth === 0) {
      items.push(list.slice(start, index))
      start = index + 1
    }
  }
  items.push(list.slice(start))
  return items.map(item => item.trim()).filter(item => item !== '')
}

/** 与 `open` 处括号配对的右括号的位置。 */
function closing(code: string, open: number): number | undefined {
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    if ('([{'.includes(code[index]!)) depth += 1
    else if (')]}'.includes(code[index]!) && --depth === 0) return index
  }
  return undefined
}

/** 函数体左花括号的位置；`interface{}` 与 `struct{…}` 的花括号属于结果类型。 */
function bodyStart(code: string, from: number): number | undefined {
  for (let index = from; index < code.length; index += 1) {
    const char = code[index]!
    if (char === '(' || char === '[') index = closing(code, index) ?? code.length
    else if (char === '{') {
      if (!/\b(?:interface|struct)\s*$/.test(code.slice(from, index))) return index
      index = closing(code, index) ?? code.length
    }
  }
  return undefined
}

/**
 * 读一个原子文件：它声明的包、导入、全局声明，以及唯一的函数。
 *
 * 函数是一个没有接收者的具名函数，或值为函数字面量的顶层 `var`；方法、类型、常量和其余变量都是全局声明，
 * 原样随原子写出。文件开头 `package` 之前的内容（例如构建约束）不写出。
 * @param file - 文件名，原子的 ID。
 * @param text - 文件全文。
 * @returns 原子，或它不能作为原子的原因。
 */
export function goAtom(file: string, text: string): Atom | AtomFault {
  let pkg = ''
  const imports: string[] = []
  const globals: string[] = []
  const functions: { code: string; signature: Signature | undefined; name: string }[] = []
  for (const declaration of declarations(text)) {
    const body = declaration.replace(/^(?:\s*\/\/[^\n]*)*\s*/, '')
    const named = /^func\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(body)
    const closure = /^var\s+([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(func\b[\s\S]*)$/u.exec(body)
    if (body.startsWith('package')) pkg = body.slice('package'.length).trim()
    else if (body.startsWith('import')) imports.push(...importSpecs(body.slice('import'.length)))
    else if (named !== null) functions.push({ code: declaration, signature: goSignature(body), name: named[1]! })
    else if (closure !== null) functions.push({ code: declaration, signature: goSignature(closure[2]!), name: closure[1]! })
    else globals.push(declaration)
  }
  if (functions.length === 0) return { file, fault: 'no-function' }
  if (functions.length > 1) return { file, fault: 'several-functions' }
  const [{ code, signature, name }] = functions as [typeof functions[number]]
  if (signature === undefined) return { file, fault: 'unreadable-signature' }
  return { file, package: pkg, imports, globals, code, signature: { ...signature, name } }
}

/** 一条 `import` 声明中的导入项，按原文，不含注释。 */
function importSpecs(rest: string): string[] {
  const group = /^\s*\(([\s\S]*)\)\s*$/.exec(rest)
  return (group === null ? [rest] : group[1]!.split('\n'))
    .map(line => line.replace(/\/\/.*$/, '').trim())
    .filter(line => line !== '')
}

/**
 * 文件的顶层声明，各带紧贴其上的文档注释。
 *
 * gofmt 让每条顶层声明从行首的关键字开始，因此只在括号外、字符串和注释外的行首寻找它们。
 */
function declarations(text: string): string[] {
  const lines = text.split('\n')
  const starts: number[] = []
  let depth = 0
  let state: 'code' | 'line' | 'block' | 'string' | 'rune' | 'raw' = 'code'
  let line = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if ((index === 0 || text[index - 1] === '\n') && state === 'code' && depth === 0
      && /^(?:package|import|var|const|type|func)\b/.test(lines[line]!)) starts.push(line)
    if (char === '\n') line += 1
    switch (state) {
      case 'code':
        if (char === '/' && text[index + 1] === '/') state = 'line'
        else if (char === '/' && text[index + 1] === '*') state = 'block'
        else if (char === '"') state = 'string'
        else if (char === "'") state = 'rune'
        else if (char === '`') state = 'raw'
        else if ('([{'.includes(char)) depth += 1
        else if (')]}'.includes(char)) depth -= 1
        break
      case 'line':
        if (char === '\n') state = 'code'
        break
      case 'block':
        if (char === '*' && text[index + 1] === '/') {
          state = 'code'
          index += 1
        }
        break
      case 'string':
      case 'rune':
        if (char === '\\') index += 1
        else if (char === (state === 'string' ? '"' : "'")) state = 'code'
        break
      case 'raw':
        if (char === '`') state = 'code'
        break
    }
  }
  // 文档注释属于它下面的声明，而不是上一条。
  const begins = starts.map((start, position) => {
    let begin = start
    while (begin > (starts[position - 1] ?? -1) + 1 && lines[begin - 1]!.startsWith('//')) begin -= 1
    return begin
  })
  return begins.map((begin, position) => lines.slice(begin, begins[position + 1] ?? lines.length).join('\n').trimEnd())
}

/**
 * 一个导入项在代码中的包名：别名，否则取导入路径的最后一段。
 *
 * 包名由被导入的包自己声明，这里按常见的命名习惯推断：跳过 `/v2` 这样的主版本段，去掉 `.v3` 后缀和
 * `go-` 前缀或 `-go` 后缀。
 * @param spec - 导入项，例如 `"net/http"` 或 `str "strings"`。
 * @returns 包名；空白导入 `_` 和点导入 `.` 没有包名。
 */
export function goImportName(spec: string): string | undefined {
  const match = /^(?:([\p{L}_][\p{L}\p{N}_]*|[._])\s+)?"([^"]+)"$/u.exec(spec)
  if (match === null || match[1] === '_' || match[1] === '.') return undefined
  if (match[1] !== undefined) return match[1]
  const segments = match[2]!.split('/')
  const last = /^v\d+$/.test(segments.at(-1)!) && segments.length > 1 ? segments.at(-2)! : segments.at(-1)!
  return last.replace(/\.v\d+$|^go-|-go$/g, '').replaceAll(/[^\p{L}\p{N}_]/gu, '_')
}
