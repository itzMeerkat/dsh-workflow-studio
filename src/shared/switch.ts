/**
 * 多路分支：按一个值等于哪个 case 触发同名的执行引脚，都不等时触发 {@link SWITCH_DEFAULT_PIN}。
 *
 * case 写在节点配置里，所以每个节点的执行引脚取自它自己的配置，而不是节点类型。
 * @module dsh-workflow-studio
 */

import type { DagNodeDefinition } from './types.ts'

/** 多路分支节点类型。 */
export const SWITCH_TYPE = 'switch'

/** 存放 case 的配置字段，值是 case 文本的数组。 */
export const SWITCH_CASES = 'cases'

/** 值不等于任何 case 时触发的执行引脚；它不能同时是一个 case。 */
export const SWITCH_DEFAULT_PIN = 'default'

/**
 * 节点配置中的 case，按作者写下的顺序。
 * @param config - 多路分支节点的配置。
 * @returns case 文本；配置没有 case 时为空。
 */
export function switchCases(config: DagNodeDefinition['config']): readonly string[] {
  const cases = config[SWITCH_CASES]
  return Array.isArray(cases) ? cases.map(String) : []
}

/**
 * 多路分支节点的执行引脚：每个 case 一个，最后是 {@link SWITCH_DEFAULT_PIN}。
 * @param config - 多路分支节点的配置。
 */
export function switchPins(config: DagNodeDefinition['config']): readonly string[] {
  return [...switchCases(config), SWITCH_DEFAULT_PIN]
}

/**
 * 一组 case 为什么不能作为执行引脚；能时为 undefined。
 * @param cases - case 文本。
 * @returns 第一个空的、重复的或与 {@link SWITCH_DEFAULT_PIN} 同名的 case。
 */
export function invalidCase(cases: readonly string[]): string | undefined {
  return cases.find((item, index) => item === '' || item === SWITCH_DEFAULT_PIN || cases.indexOf(item) !== index)
}

/**
 * 值匹配的 case。字符串、数字和布尔值按文本比较，因此 case `3` 匹配数字 3，case `true` 匹配 true。
 * @param value - 送进节点的值。
 * @param cases - case 文本。
 * @returns 触发的执行引脚；值不是字符串、数字或布尔值时为 undefined。
 */
export function switchPin(value: unknown, cases: readonly string[]): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  return cases.find(item => item === String(value)) ?? SWITCH_DEFAULT_PIN
}
