/**
 * 错误信息提取与穷尽检查。
 * @module dsh-workflow-studio
 */

/**
 * 错误的可读信息。
 * @param error - 捕获的值。
 * @returns Error 的 message，其他值的字符串形式。
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 穷尽检查：闭合联合的每个成员都已处理时，这里不可达。
 * @param value - 未被任何分支处理的值，类型为 never。
 * @throws 总是抛出；运行到这里说明值来自声明之外，例如读回了更新版本写下的数据。
 */
export function assertNever(value: never): never {
  throw new Error(`未覆盖的取值: ${JSON.stringify(value) ?? String(value)}`)
}
