/**
 * WorkflowNode 基类单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NodeFailure, WorkflowNode, type WorkflowNodePorts } from '../src/node.ts'
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

describe('WorkflowNode', () => {
  it('输入和输出端口就是子类声明的端口', () => {
    assert.deepEqual(new ProbeNode().inputs, [{ name: 'value', type: 'any', required: false }])
    assert.deepEqual(new ProbeNode().outputs, [{ name: 'output', type: 'any' }])
  })

  it('同步和异步 run 都返回 completed，且 run 收到全部输入', async () => {
    const node = new ProbeNode()

    assert.deepEqual(
      await node.execute(context({ inputs: { value: 3 } })),
      { status: 'completed', outputs: { output: 3 } },
    )
    assert.deepEqual(node.seen, { value: 3 })
    assert.deepEqual(
      await node.execute(context({ config: { mode: 'async' } })),
      { status: 'completed', outputs: { output: 'later' } },
    )
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

  it('非 NodeFailure 错误原样抛出', async () => {
    await assert.rejects(new ProbeNode().execute(context({ config: { mode: 'crash' } })), /unexpected/)
  })
})
