/**
 * `human-approval` 节点测试：审批、拒绝的两种模式、condition 门控和重启后的复用。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createDemoNodes } from '../src/demo/index.ts'
import * as nodesPlugin from '../src/nodes/index.ts'
import { HumanApprovalNode } from '../src/nodes/index.ts'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import { EdgeId, NodeId, type RunId } from '../src/types.ts'
import type { DagEdgeDefinition, DagNodeDefinition } from '../src/types.ts'
import type { DagEngineProvider } from '../src/engine-provider.ts'
import { TestHosts, inputRequested, runEnded } from './host.ts'

const APPROVE = { answers: [{ id: 'decision', selected: ['批准'] }] }
const REJECT_WITH = (comment: string) => ({ answers: [{ id: 'decision', selected: [], custom: comment }] })

function edge(source: string, target: string, sourcePort?: string, targetPort?: string): DagEdgeDefinition {
  return {
    id: EdgeId(`${source}.${sourcePort ?? 'output'}->${target}.${targetPort ?? 'input'}`),
    source: NodeId(source),
    target: NodeId(target),
    ...(sourcePort === undefined ? {} : { sourcePort }),
    ...(targetPort === undefined ? {} : { targetPort }),
  }
}

function node(id: string, type: string, config: Record<string, unknown> = {}): DagNodeDefinition {
  return { id: NodeId(id), type, config }
}

/** value(5) → approval → passed (gated by approved), rejectedPath (gated by rejected). */
async function saveApprovalFlow(engine: DagEngineProvider, onReject: 'fail' | 'branch'): Promise<RunId> {
  const workflowId = await engine.save({
    name: `approval-${onReject}`,
    nodes: [
      node('value', 'input', { defaultValue: 5 }),
      node('approval', 'human-approval', { question: 'Ship it?', onReject }),
      node('passed', 'output'),
      node('rejectedPath', 'output'),
    ],
    edges: [
      edge('value', 'approval'),
      edge('approval', 'passed', 'output'),
      edge('approval', 'passed', 'approved', 'condition'),
      edge('value', 'rejectedPath'),
      edge('approval', 'rejectedPath', 'rejected', 'condition'),
    ],
  })
  return engine.start(workflowId).runId
}

function status(result: { nodeRecords: Array<{ nodeId: string; status: string }> }, nodeId: string): string | undefined {
  return result.nodeRecords.find(record => record.nodeId === nodeId)?.status
}

describe('human-approval 节点', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  async function start() {
    return hosts.start(await hosts.root(), [...createDemoNodes(), new HumanApprovalNode()])
  }

  it('向审批人展示输入；批准后传递输入并输出 approved 信号', async () => {
    const { ctx, engine } = await start()
    const requested = inputRequested(ctx, 'approval')
    const runId = await saveApprovalFlow(engine, 'fail')
    assert.equal((await requested).requestId, 'approval')

    const request = engine.getRunRecord(runId)!.nodes.find(item => item.nodeId === NodeId('approval'))!.interactions![0]!
    assert.deepEqual(request.questions, [{
      id: 'decision',
      header: '人工审批',
      question: 'Ship it?',
      detail: '5',
      options: [{ label: '批准' }, { label: '拒绝' }],
    }])

    const done = runEnded(ctx, runId)
    await engine.answerInput(runId, NodeId('approval'), 'approval', APPROVE)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodeRecords.find(record => record.nodeId === NodeId('approval'))?.outputs, { approved: true, output: 5 })
    assert.equal(status(result, 'passed'), 'completed')
    assert.equal(status(result, 'rejectedPath'), 'skipped')
  })

  it('默认拒绝时节点失败，并把说明写入错误和 comment 输出', async () => {
    const { ctx, engine } = await start()
    const requested = inputRequested(ctx, 'approval')
    const runId = await saveApprovalFlow(engine, 'fail')
    await requested
    const done = runEnded(ctx, runId)
    await engine.answerInput(runId, NodeId('approval'), 'approval', REJECT_WITH('numbers look wrong'))
    const result = await done
    assert.equal(result.status, 'failed')
    const approval = result.nodeRecords.find(record => record.nodeId === NodeId('approval'))
    assert.equal(approval?.error, '审批被拒绝: numbers look wrong')
    assert.deepEqual(approval?.outputs, { comment: 'numbers look wrong' })
  })

  it('branch 模式拒绝时输出 rejected 信号并继续执行拒绝分支', async () => {
    const { ctx, engine } = await start()
    const requested = inputRequested(ctx, 'approval')
    const runId = await saveApprovalFlow(engine, 'branch')
    await requested
    const done = runEnded(ctx, runId)
    await engine.answerInput(runId, NodeId('approval'), 'approval', { answers: [{ id: 'decision', selected: ['拒绝'] }] })
    const result = await done
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodeRecords.find(record => record.nodeId === NodeId('approval'))?.outputs, { rejected: true })
    assert.equal(status(result, 'passed'), 'skipped')
    assert.equal(status(result, 'rejectedPath'), 'completed')
  })

  it('condition 为 false 时跳过且不提问', async () => {
    const { ctx, engine } = await start()
    let asked = false
    ctx.on('dag/input-requested', () => { asked = true })
    const workflowId = await engine.save({
      name: 'gated-approval',
      nodes: [
        node('left', 'input', { defaultValue: 1 }),
        node('right', 'input', { defaultValue: 2 }),
        node('check', 'if', { expression: 'left > right' }),
        node('approval', 'human-approval'),
      ],
      edges: [
        edge('left', 'check', undefined, 'left'),
        edge('right', 'check', undefined, 'right'),
        edge('check', 'approval', 'true', 'condition'),
      ],
    })
    const result = await engine.start(workflowId).result
    assert.equal(result.status, 'completed')
    assert.equal(status(result, 'approval'), 'skipped')
    assert.equal(asked, false)
  })

  it('重启后复用未回答的审批请求', async () => {
    const root = await hosts.root()
    const executors = () => [...createDemoNodes(), new HumanApprovalNode()]
    const first = await hosts.start(root, executors())
    const requested = inputRequested(first.ctx, 'approval')
    const runId = await saveApprovalFlow(first.engine, 'fail')
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors())
    const again = inputRequested(second.ctx, 'approval')
    await again
    const done = runEnded(second.ctx, runId)
    await second.engine.answerInput(runId, NodeId('approval'), 'approval', APPROVE)
    const result = await done
    assert.equal(result.status, 'completed')
    const approval = result.nodeRecords.find(record => record.nodeId === NodeId('approval'))
    assert.equal(approval?.attempts, 2)
    assert.equal(approval?.interactions?.length, 1)
  })

  it('非法配置使节点失败', async () => {
    const { engine } = await start()
    const workflowId = await engine.save({
      name: 'bad-approval',
      nodes: [node('approval', 'human-approval', { onReject: 'ignore' })],
      edges: [],
    })
    const result = await engine.start(workflowId).result
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /onReject 必须为 fail 或 branch/)
  })

  it('插件以 dsh-workflow-studio/nodes 注册节点并随卸载移除', async () => {
    const ctx = new Context()
    await ctx.plugin(WorkflowNodeRegistry)
    const fork = ctx.plugin(nodesPlugin)
    await fork
    const summary = ctx.workflowNodeRegistry.listTypes().find(item => item.type === 'human-approval')
    assert.equal(summary?.sourcePlugin, 'dsh-workflow-studio/nodes')
    assert.deepEqual(summary?.inputs.map(port => port.name), ['input', 'condition'])
    await fork.dispose()
    assert.equal(ctx.workflowNodeRegistry.get('human-approval'), undefined)
    await ctx.fiber.dispose()
  })
})
