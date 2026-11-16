/**
 * 多路分支：运行时触发值匹配的 case，其他引脚后的节点被跳过。
 */

import { afterEach,describe,it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { WorkflowStudioController } from '../src/controller.ts'
import { SWITCH_CASES } from '../src/shared/switch.ts'
import { RunId } from '../src/shared/types.ts'
import { WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts,runEnded } from './host.ts'

const sw = (...cases: string[]) => ({ type: 'switch', config: { [SWITCH_CASES]: cases } })

describe('运行中的多路分支', () => {
  const hosts = new TestHosts()
  let host: Context

  afterEach(async () => { await hosts.cleanup() })

  async function setup(): Promise<WorkflowStudioController> {
    const { ctx } = await hosts.start(await hosts.root(), createFixtureNodes())
    host = ctx
    return new WorkflowStudioController(ctx)
  }

  /** 把 2 送进有 `cases` 的多路分支，`pin` 引脚接 `hit`，default 接 `miss`。 */
  const saved = async (controller: WorkflowStudioController, cases: string[], pin: string) =>
    (await controller.save(workflow({
      two: { type: 'value', config: { value: 2 } },
      s: sw(...cases),
      hit: { type: 'value', config: { value: 1 } },
      miss: { type: 'value', config: { value: 0 } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [] },
    }, ['two>s:value', `s.${pin}>hit`, 's.default>miss'], { name: 'switch' })) as { workflowId: string }).workflowId

  it('触发值匹配的 case，其他引脚后的节点被跳过', async () => {
    const controller = await setup()
    const record = await runEnded(host, RunId(controller.start(await saved(controller, ['1', '2'], '2'), {})))
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.nodes.filter(node => node.nodeId !== 'out').map(node => [node.nodeId, node.status]), [
      ['two', 'completed'], ['s', 'completed'], ['hit', 'completed'], ['miss', 'skipped'],
    ])
  })
})
