/**
 * 模型面工作流工具测试。
 */

import { describe,it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerWorkflowTools } from '../src/tools.ts'
import { WorkflowId } from '../src/shared/types.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { nodeType,workflow } from './graph-fixtures.ts'

/** 已保存的唯一一个工作流：把输入交给一个审批节点。 */
const SAVED_FLOW = workflow({
  in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'order', type: 'any' }] },
  approval: { type: 'hitl', inputs: [{ name: 'input', type: 'any' }] },
}, ['in:order>approval'], { name: 'review order' })

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
      findByName: (name: string) => name === SAVED_FLOW.name ? { id: WorkflowId('review-order') } : undefined,
      list: () => [{ id: WorkflowId('review-order') }],
      get: () => SAVED_FLOW,
    },
    workflowNodeRegistry: {
      listTypes: () => [
        nodeType('hitl', { inputs: [{ name: 'input', type: 'any' }], outputs: [{ name: 'output', type: 'any' }] }),
        nodeType(WORKFLOW_INPUT_TYPE),
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

  it('describe_workflow 把工作流写成伪代码', async () => {
    const fixture = setup()
    const describeTool = fixture.definitions.get('describe_workflow') as unknown as CallableTool

    assert.deepEqual(await describeTool.execute({ name: 'review order' }, {}), {
      name: 'review order',
      description: 'workflow review_order(order):\n  hitl = hitl(input: order)\n',
      warnings: [],
    })
  })
})
