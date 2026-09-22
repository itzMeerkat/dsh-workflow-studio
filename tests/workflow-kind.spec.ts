/**
 * 工作流种类：快照往返、节点种类校验与旧记录的默认值。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { validateWorkflow } from '../src/validation.ts'
import { NodeId, type WorkflowKind, type WorkflowNodeExecutor } from '../src/shared/types.ts'
import {
  workflowDefinitionSchema, workflowStudioSnapshotSchema,
} from '../src/shared/workflow-schema.ts'

/** 只能出现在 code 工作流里的节点。 */
const codeOnly: WorkflowNodeExecutor = {
  type: 'code-only',
  label: '仅代码',
  description: '',
  kinds: ['code'],
  inputs: [],
  outputs: [],
  execute: () => ({ status: 'completed', outputs: {} }),
}

function registry(): { registry: WorkflowNodeRegistry; dispose: () => Promise<void> } {
  const ctx = new Context()
  const created = new WorkflowNodeRegistry(ctx)
  created.register(codeOnly, 'test')
  return { registry: created, dispose: async () => { await ctx.fiber.dispose() } }
}

describe('工作流种类', () => {
  it('没有声明种类的旧记录按 run 读回', () => {
    const parsed = workflowDefinitionSchema.parse({ name: 'legacy', nodes: [], edges: [] })
    assert.equal(parsed.kind, 'run')
  })

  it('快照保留节点类型的执行语义和适用种类', () => {
    const snapshot = workflowStudioSnapshotSchema.parse({
      workflows: [{ id: 'w', name: 'w', kind: 'code', definition: '{}' }],
      nodeTypes: [{
        type: 'merge',
        label: '分支合并',
        description: '',
        sourcePlugin: 'dsh-workflow-studio',
        execKind: 'join',
        kinds: ['run', 'code'],
        inputs: [],
        outputs: [],
        execOutputs: ['then'],
        controls: [],
      }],
    })
    assert.equal(snapshot.workflows[0]?.kind, 'code')
    assert.equal(snapshot.nodeTypes[0]?.execKind, 'join')
    assert.deepEqual(snapshot.nodeTypes[0]?.kinds, ['run', 'code'])
  })

  it('节点类型不适用于该种类的工作流、或 code 工作流没有语言时保存被拒绝', async () => {
    const fixture = registry()
    const definition = {
      name: 'mixed',
      kind: 'run' as const,
      nodes: [{ id: NodeId('only'), type: 'code-only', config: {} }],
      edges: [],
    }
    assert.throws(() => { validateWorkflow(fixture.registry, definition) }, /只能用在 code 工作流中/)

    const asCode = { ...definition, kind: 'code' as WorkflowKind }
    assert.throws(() => { validateWorkflow(fixture.registry, asCode) }, /语言必须是/)
    validateWorkflow(fixture.registry, { ...asCode, language: 'go' })
    await fixture.dispose()
  })
})
