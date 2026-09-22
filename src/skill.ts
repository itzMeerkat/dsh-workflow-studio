/**
 * 随本插件提供的技能：指导 Agent 把已有代码拆成原子并连成 `code` 工作流。
 * @module dsh-workflow-studio
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

/** 技能名，也是 `/` 调用它的命令名。 */
export const WORKFLOW_CODE_SKILL = 'workflow-code-atoms'

/**
 * 在存在 `ctx.skills` 的组合中注册该技能；技能正文是包内的 `skills/workflow-code-atoms.md`。
 * @param ctx - 插件 context。
 */
export function registerWorkflowSkill(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    const content = readFileSync(new URL(`../skills/${WORKFLOW_CODE_SKILL}.md`, import.meta.url), 'utf8')
    scope.effect(() => scope.skills.register({
      name: WORKFLOW_CODE_SKILL,
      description: 'Split existing code into atoms — one Go function per step — and wire them into a Workflow Studio '
        + '`code` workflow with create_workflow, then check the generated Go with describe_workflow. Use when asked to '
        + 'turn code into a workflow, visualize or restructure a function as a graph, or build a code workflow.',
      source: 'bundled',
      content,
    }), `workflow-studio:skill:${WORKFLOW_CODE_SKILL}`)
  })
}
