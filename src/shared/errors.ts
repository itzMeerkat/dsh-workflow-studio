/**
 * 错误信息提取。
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
