/**
 * 工作流记录键的取名规则。
 *
 * 工作流 ID 同时是 JSON 存储后端的记录文件名（`workflows/<id>.json`），因此 ID 由工作流名称派生，
 * 使存储目录可直接阅读。后端只接受 `[A-Za-z0-9_-]`，名称中的其他字符（包括所有非 ASCII 字符）
 * 无法保留在文件名中。
 * @module dsh-workflow-studio
 */

/** 记录键的最大长度，留出文件系统 255 字节名称上限内的余量。 */
const MAX_SLUG_LENGTH = 64

/** 名称中没有任何字符可用于记录键时的基名。 */
const FALLBACK_SLUG = 'workflow'

/**
 * 把工作流名称转换为记录键基名。
 * @param name - 工作流名称。
 * @returns 小写、以 `-` 分隔的基名；名称不含 ASCII 字母数字时为 `workflow`。
 */
export function workflowSlug(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? FALLBACK_SLUG : slug
}

/**
 * 为工作流名称分配一个未被占用的记录键。
 *
 * 名称唯一而基名不唯一：`My Flow` 与 `my-flow` 派生同一个基名，非 ASCII 名称都派生 `workflow`，
 * 因此被占用的基名按 `-2`、`-3` 递增。
 * @param name - 工作流名称。
 * @param taken - 判断一个候选键是否已被其他工作流占用。
 * @returns 未被占用的记录键。
 */
export function uniqueWorkflowSlug(name: string, taken: (candidate: string) => boolean): string {
  const base = workflowSlug(name)
  if (!taken(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken(candidate)) return candidate
  }
}
