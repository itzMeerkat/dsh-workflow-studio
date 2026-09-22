/**
 * 随插件提供的技能：注册进技能表，正文随包发布。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { WORKFLOW_CODE_SKILL, registerWorkflowSkill } from '../src/skill.ts'

describe('workflow-code-atoms 技能', () => {
  it('技能表存在时注册，模型和用户都能调用，卸载时移除', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fork = ctx.plugin({ name: 'studio-skill', apply: registerWorkflowSkill })
    await fork

    const skill = await ctx.skills.get(WORKFLOW_CODE_SKILL)
    assert.deepEqual(skill?.invocation, { modelInvocable: true, userInvocable: true })
    assert.match(skill?.content ?? '', /create_workflow/)

    await fork.dispose()
    assert.equal(await ctx.skills.get(WORKFLOW_CODE_SKILL), undefined)
    await ctx.fiber.dispose()
  })
})
