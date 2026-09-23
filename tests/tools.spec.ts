/**
 * 模型面工作流工具测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerWorkflowTools } from '../src/tools.ts'
import { WorkflowId } from '../src/shared/types.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { nodeType, workflow } from './graph-fixtures.ts'

/** 已保存的唯一一个工作流：一个空的 Go 工作流。 */
const CODE_FLOW = workflow({}, [], { name: 'code-flow', kind: 'code', language: 'go' })

interface CallableTool {
  execute(args: Record<string, unknown>, execution: unknown): unknown
}

function setup() {
  const definitions = new Map<string, ToolDefinition>()
  let saved: DagWorkflowDefinition | undefined
  const disposers: Array<() => void> = []
  const ctx = {
    effect(register: () => () => void) { disposers.push(register()) },
    dagEngine: {
      async save(definition: DagWorkflowDefinition) {
        saved = definition
        return WorkflowId('workflow-id')
      },
      findByName: (name: string) => name === CODE_FLOW.name ? { id: WorkflowId('code-flow') } : undefined,
      get: () => CODE_FLOW,
    },
    workflowNodeRegistry: {
      listTypes: () => [
        nodeType('hitl', { kinds: ['code'], outputs: [{ name: 'output', type: 'any' }] }),
      ],
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
  registerWorkflowTools(ctx)
  const dispose = (): void => { for (const dispose of disposers.splice(0).reverse()) dispose() }
  return { definitions, dispose, saved: () => saved }
}

describe('workflow tools', () => {
  it('create_workflow 拒绝伪造缺失字段，保留工作流种类和语言', async () => {
    const fixture = setup()
    const create = fixture.definitions.get('create_workflow') as unknown as CallableTool

    await assert.rejects(
      async () => create.execute({
        name: 'invalid',
        kind: 'run' as const,
        nodes: [{ type: 'source' }],
        edges: [],
      }, {}),
      /id/,
    )

    await create.execute({
      name: 'valid',
      kind: 'code',
      language: 'go',
      nodes: [{
        id: 'approval',
        type: 'hitl',
        config: {},
        inputs: [],
        outputs: [{ name: 'output', type: 'any' }],
      }],
      edges: [],
    }, {})

    assert.deepEqual(fixture.saved()?.nodes[0]?.outputs, [{ name: 'output', type: 'any' }])
    assert.equal(fixture.saved()?.kind, 'code')
    assert.equal(fixture.saved()?.language, 'go')
  })

  it('describe_workflow 写成工作流指定的语言', async () => {
    const fixture = setup()
    const describeTool = fixture.definitions.get('describe_workflow') as unknown as CallableTool

    assert.deepEqual(await describeTool.execute({ name: 'code-flow' }, {}), {
      name: 'code-flow',
      language: 'go',
      source: '// Code generated from workflow "code-flow". DO NOT EDIT.\n\nfunc code_flow() {\n}\n',
      warnings: [],
    })
  })

  it('run_workflow 对未知名称抛错，卸载 context 时移除全部工具', async () => {
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
