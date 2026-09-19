/**
 * 模型面工作流工具测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerWorkflowTools } from '../src/tools.ts'
import { WorkflowId } from '../src/types.ts'
import type { DagWorkflowDefinition } from '../src/types.ts'

interface CallableTool {
  execute(args: Record<string, unknown>, execution: unknown): unknown
}

function setup() {
  const definitions = new Map<string, ToolDefinition>()
  let saved: DagWorkflowDefinition | undefined
  const ctx = {
    dagEngine: {
      async save(definition: DagWorkflowDefinition) {
        saved = definition
        return WorkflowId('workflow-id')
      },
      findByName: () => undefined,
    },
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition)
        return () => {
          if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        }
      },
    },
  } as unknown as Context
  const dispose = registerWorkflowTools(ctx)
  return { definitions, dispose, saved: () => saved }
}

describe('workflow tools', () => {
  it('create_workflow 拒绝伪造缺失字段并保留 HITL 标记', async () => {
    const fixture = setup()
    const create = fixture.definitions.get('create_workflow') as unknown as CallableTool

    await assert.rejects(
      async () => create.execute({
        name: 'invalid',
        nodes: [{ type: 'source' }],
        edges: [],
      }, {}),
      /id/,
    )

    await create.execute({
      name: 'valid',
      nodes: [{
        id: 'approval',
        type: 'hitl',
        config: {},
        requiresHumanInput: true,
        inputs: [],
        outputs: [{ name: 'output', type: 'any' }],
      }],
      edges: [],
    }, {})

    assert.equal(fixture.saved()?.nodes[0]?.requiresHumanInput, true)
  })

  it('run_workflow 对未知名称抛错且 disposer 卸载两个工具', async () => {
    const fixture = setup()
    const run = fixture.definitions.get('run_workflow') as unknown as CallableTool

    await assert.rejects(
      async () => run.execute({ name: 'missing' }, {}),
      /工作流 "missing" 未找到/,
    )

    fixture.dispose()
    assert.equal(fixture.definitions.size, 0)
  })
})
