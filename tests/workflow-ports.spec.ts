/**
 * 工作流边界节点测试：调用方的输入值与声明的默认值进入图中。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TestHosts, runEnded } from './host.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import type { DagWorkflowDefinition } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'

describe('工作流边界节点', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  /** left 与 right 取自工作流输入，结果送到工作流输出。 */
  function ioWorkflow(): DagWorkflowDefinition {
    return workflow({
      in: {
        type: WORKFLOW_INPUT_TYPE,
        outputs: [{ name: 'left', type: 'number' }, { name: 'right', type: 'number', default: 5 }],
      },
      add: { type: 'sum', config: { offset: 0 } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'total', type: 'number', required: false }] },
    }, ['in:left>add:left', 'in:right>add:right', 'add:result>out:total'], { name: 'io' })
  }

  it('调用方提供的输入进入图中，缺省的输入用声明的默认值', async () => {
    const { ctx, engine } = await hosts.start(await hosts.root(), createFixtureNodes())
    const workflowId = await engine.save(ioWorkflow())

    const record = await runEnded(ctx, engine.start(workflowId, { left: 3 }).runId)

    assert.equal(record.status, 'completed')
    assert.deepEqual(record.outputs, { total: 8 })
    assert.deepEqual(record.nodes.find(node => node.nodeId === 'in')?.outputs, { left: 3, right: 5 })
  })
})
