/**
 * 读 Go 函数的签名：函数节点接受哪些参数、返回哪些结果。
 *
 * 只读到函数体的左花括号为止，因此代码可以是具名函数，也可以是函数字面量（闭包）；
 * 不支持方法接收者和类型参数。
 * @module dsh-workflow-studio
 */

import type { Signature, TypedName } from './language.ts'
import type { PortType } from './types.ts'

/** 开头即是类型的关键字：`chan int` 是一个类型，而不是名为 `chan` 的参数。 */
const TYPE_KEYWORDS = new Set(['chan', 'func', 'interface', 'map', 'struct'])

/**
 * 一段 Go 代码开头的函数的签名。
 * @param code - 函数节点的代码。
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
