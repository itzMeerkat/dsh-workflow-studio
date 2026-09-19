/**
 * WorkflowNode 基类单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { CONDITION_PORT, NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import type { NodeExecutionContext } from '../src/shared/types.ts'
import { RunId } from '../src/shared/types.ts'

function context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    runId: RunId('run'),
    config: {},
    inputs: {},
    connected: new Set(),
    invocationKey: 'run/node',
    notepad: { value: undefined, save: async () => {} },
    awaitSignal: async () => { throw new Error('unused') },
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  }
}

/** 记录 run() 收到的输入，并按 config.mode 返回、抛出或异步完成。 */
class ProbeNode extends WorkflowNode {
  readonly type = 'probe'
  readonly label = 'Probe'
  readonly description = 'Records its inputs'
  seen: Record<string, unknown> | undefined
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'value', type: 'any', required: false }],
    outputs: [{ name: 'output', type: 'any' }],
  }

  protected run({ config, inputs }: NodeExecutionContext): Record<string, unknown> | Promise<Record<string, unknown>> {
    this.seen = inputs
    switch (config.mode) {
      case 'fail':
        throw new NodeFailure('planned', { partial: 1 })
      case 'crash':
        throw new Error('unexpected')
      case 'async':
        return Promise.resolve({ output: 'later' })
      case 'async-fail':
        return Promise.reject(new NodeFailure('async planned'))
      default:
        return { output: inputs.value }
    }
  }
}

class FlowNode extends ProbeNode {
  protected override readonly conditional = false
}

class ReservedNode extends ProbeNode {
  protected override readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'condition', type: 'boolean' }],
    outputs: [],
  }
}

describe('WorkflowNode 端口', () => {
  it('条件节点在业务输入后追加 condition 端口', () => {
    assert.deepEqual(new ProbeNode().inputs, [{ name: 'value', type: 'any', required: false }, CONDITION_PORT])
    assert.deepEqual(new ProbeNode().outputs, [{ name: 'output', type: 'any' }])
  })

  it('conditional 为 false 的节点没有 condition 端口', () => {
    assert.deepEqual(new FlowNode().inputs.map(port => port.name), ['value'])
  })

  it('条件节点声明 condition 业务输入时注册被拒绝', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkflowNodeRegistry)
    assert.throws(() => ctx.workflowNodeRegistry.register(new ReservedNode(), 'tests'), /输入端口 condition 重复/)
    await ctx.fiber.dispose()
  })
})

describe('WorkflowNode condition 门控', () => {
  const node = new ProbeNode()

  it('condition 未连接时不门控', () => {
    assert.equal(node.preflight(context()), undefined)
  })

  it('已连接的 condition 按值执行、跳过或失败', () => {
    const connected = new Set(['condition'])
    assert.equal(node.preflight(context({ connected, inputs: { condition: true } })), undefined)
    assert.deepEqual(node.preflight(context({ connected, inputs: { condition: false } })), { status: 'skipped' })
    assert.deepEqual(node.preflight(context({ connected })), { status: 'skipped' })
    assert.deepEqual(
      node.preflight(context({ connected, inputs: { condition: undefined } })),
      { status: 'failed', error: 'condition 输入必须为布尔值' },
    )
    assert.deepEqual(
      node.preflight(context({ connected, inputs: { condition: 1 } })),
      { status: 'failed', error: 'condition 输入必须为布尔值' },
    )
  })

  it('conditional 为 false 的节点不门控', () => {
    const flow = new FlowNode()
    assert.equal(flow.preflight(context({ connected: new Set(['condition']), inputs: { condition: false } })), undefined)
  })
})

describe('WorkflowNode execute', () => {
  it('同步 run 返回 completed，且 run 看不到 condition', async () => {
    const node = new ProbeNode()
    const result = await node.execute(context({ inputs: { value: 3, condition: true } }))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 3 } })
    assert.deepEqual(node.seen, { value: 3 })
  })

  it('conditional 为 false 的节点收到完整输入', async () => {
    const node = new FlowNode()
    await node.execute(context({ inputs: { value: 3, condition: true } }))
    assert.deepEqual(node.seen, { value: 3, condition: true })
  })

  it('NodeFailure 转换为带诊断输出的失败结果', async () => {
    const node = new ProbeNode()
    assert.deepEqual(
      await node.execute(context({ config: { mode: 'fail' } })),
      { status: 'failed', error: 'planned', outputs: { partial: 1 } },
    )
    assert.deepEqual(
      await node.execute(context({ config: { mode: 'async-fail' } })),
      { status: 'failed', error: 'async planned' },
    )
  })

  it('异步 run 返回 completed', async () => {
    assert.deepEqual(
      await new ProbeNode().execute(context({ config: { mode: 'async' } })),
      { status: 'completed', outputs: { output: 'later' } },
    )
  })

  it('非 NodeFailure 错误原样抛出', async () => {
    await assert.rejects(new ProbeNode().execute(context({ config: { mode: 'crash' } })), /unexpected/)
  })
})
