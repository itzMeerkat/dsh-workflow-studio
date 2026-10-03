/**
 * 运行记录 JSON 值校验。
 * @module dsh-workflow-studio
 */

import type { JsonObject, JsonValue } from './types.ts'

/**
 * 返回值的独立 JSON 副本；值无法无损写入 JSON 时抛出。
 * @param value - 待持久化的值。
 * @param path - 错误信息中使用的值路径。
 * @returns 与输入结构相同的新 JSON 值。
 */
export function toJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} 不是有限数值`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => toJsonValue(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value) as unknown
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path} 不是普通 JSON 对象`)
    return toJsonObject(value as Record<string, unknown>, path)
  }
  throw new TypeError(`${path} 不是 JSON 值（${typeof value}）`)
}

/**
 * 返回对象的独立 JSON 副本；任一属性值无法写入 JSON 时抛出。
 * @param value - 待持久化的对象。
 * @param path - 错误信息中使用的值路径。
 * @returns 新 JSON 对象。
 */
export function toJsonObject(value: Record<string, unknown>, path: string): JsonObject {
  const result: JsonObject = {}
  for (const [key, item] of Object.entries(value)) result[key] = toJsonValue(item, `${path}.${key}`)
  return result
}
