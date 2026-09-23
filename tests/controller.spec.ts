/**
 * Browser Remote controller tests.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts, runEnded, signalRequested } from './host.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATOM_FIELD, CODE_ATOM_TYPE } from '../src/shared/language.ts'
import { RunId } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { WorkflowStudioController } from '../src/controller.ts'

describe('WorkflowStudioController', () => {
  const hosts = new TestHosts()
  let host: Context

  afterEach(async () => { await hosts.cleanup() })

  async function setup(): Promise<WorkflowStudioController> {
    const { ctx } = await hosts.start(await hosts.root(), createFixtureNodes())
    host = ctx
    return new WorkflowStudioController(ctx)
  }

  /** 快照中第一个工作流保存下来的定义。 */
  function savedDefinition(controller: WorkflowStudioController): { nodes: Record<string, unknown>[] } {
    const snapshot = JSON.parse(controller.snapshot()) as { workflows: { definition: string }[] }
    return JSON.parse(snapshot.workflows[0]!.definition) as { nodes: Record<string, unknown>[] }
  }

  it('保存定义、列出节点并返回完整运行结果', async () => {
    const controller = await setup()
    const workflowId = await controller.save(JSON.stringify(workflow({
      left: { type: 'value', config: { value: 10 }, position: { x: 24, y: 48 } },
      right: { type: 'value', config: { value: 20 } },
      add: { type: 'sum', config: { offset: 0 } },
    }, ['left>add:left', 'right>add:right'], { name: 'sum' })))

    const snapshot = JSON.parse(controller.snapshot()) as {
      workflows: Array<{ id: string; name: string }>
      nodeTypes: Array<{
        type: string
        sourcePlugin: string
        inputs: Array<{ name: string }>
        outputs: Array<{ name: string; display?: string }>
        execOutputs: string[]
        controls: Array<{ name: string; kind: string }>
      }>
    }
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'sum' }],
    )
    assert.deepEqual(
      snapshot.nodeTypes.map(node => node.type).sort(),
      [
        'ask', 'branch', 'code-atom', 'code-block', 'code-condition', 'greater', 'merge', 'sum', 'value',
        'workflow-input', 'workflow-output',
      ],
    )
    const sum = snapshot.nodeTypes.find(node => node.type === 'sum')
    assert.equal(sum?.sourcePlugin, 'engine-tests')
    assert.deepEqual(sum?.inputs.map(port => port.name), ['left', 'right'])
    assert.deepEqual(sum?.execOutputs, ['then'])
    assert.deepEqual(sum?.outputs.map(port => port.name), ['result'])
    assert.equal(sum?.outputs[0]?.display, 'value')
    assert.deepEqual(sum?.controls.map(control => [control.name, control.kind]), [['offset', 'number']])
    const greater = snapshot.nodeTypes.find(node => node.type === 'greater')
    assert.deepEqual(greater?.inputs.map(port => port.name), ['left', 'right'])
    const gate = snapshot.nodeTypes.find(node => node.type === 'branch')
    assert.deepEqual(gate?.execOutputs, ['true', 'false'])
    assert.deepEqual(savedDefinition(controller).nodes.find(node => node.id === 'left')?.position, { x: 24, y: 48 })

    const result = await runEnded(host, RunId(controller.start(workflowId)))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes.find(node => node.nodeId === 'add')?.outputs, { result: 30 })
  })

  it('保存的定义保留边界节点声明的端口和默认值', async () => {
    const controller = await setup()
    await controller.save(JSON.stringify(workflow({
      in: { type: 'workflow-input', outputs: [{ name: 'threshold', type: 'number', default: 3 }] },
      out: { type: 'workflow-output', inputs: [{ name: 'verdict', type: 'string', required: false }] },
    }, [], { name: 'declared' })))

    // A schema that does not declare `default` drops it, so the round trip is what proves it persists.
    assert.deepEqual(savedDefinition(controller).nodes.find(node => node.id === 'in')?.outputs, [
      { name: 'threshold', type: 'number', default: 3 },
    ])
  })

  it('等待中的请求经 signal Remote 校验后送达结果', async () => {
    const controller = await setup()
    const workflowId = await controller.save(JSON.stringify(
      workflow({ ask: 'ask' }, [], { name: 'ask' }),
    ))
    const asked = signalRequested(host)
    const runId = RunId(controller.start(workflowId))
    await asked
    const pending = (JSON.parse(controller.getRun(runId)) as {
      nodes: { status: string; requests?: { id: string; request: { kind: string } }[] }[]
    }).nodes[0]!
    assert.equal(pending.status, 'running')
    assert.deepEqual(pending.requests?.map(item => [item.id, item.request.kind]), [['pick', 'questions']])

    await assert.rejects(
      controller.signal(runId, 'ask', 'pick', JSON.stringify({ answers: [] })),
      /缺少问题 "decision"/,
    )
    const answer = { answers: [{ id: 'decision', selected: ['yes'] }] }
    const after = JSON.parse(await controller.signal(runId, 'ask', 'pick', JSON.stringify(answer))) as {
      nodes: Array<{ requests?: Array<{ result?: unknown }> }>
    }
    assert.deepEqual(after.nodes[0]?.requests?.[0]?.result, answer)

    const result = await runEnded(host, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: 'yes' })
  })

  it('按 ID 更新返回改名后的新 ID，快照只列出改名后的工作流', async () => {
    const controller = await setup()
    const source = workflow({ input: { type: 'value', config: { value: 1 } } }, [], { name: 'before' })
    assert.equal(await controller.save(JSON.stringify(source)), 'before')

    const renamed = await controller.update('before', JSON.stringify({ ...source, name: 'after' }))

    assert.equal(renamed, 'after')
    const snapshot = JSON.parse(controller.snapshot()) as {
      workflows: Array<{ id: string; name: string }>
    }
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: 'after', name: 'after' }],
    )
  })

  it('拒绝无效 JSON 和未注册节点', async () => {
    const controller = await setup()
    await assert.rejects(controller.save('{'), /JSON/)
    await assert.rejects(
      controller.save(JSON.stringify(workflow({ node: 'missing' }, [], { name: 'bad' }))),
      /未知节点类型/,
    )
  })

  it('保存带原子目录的 Go 工作流时写出目录中的 workflow.go；写不出时不保存', async () => {
    const controller = await setup()
    const folder = await mkdtemp(join(tmpdir(), 'atoms-'))
    try {
      await writeFile(join(folder, 'greet.go'), 'package hello\n\nimport "fmt"\n\nfunc Greet(name string) {\n\tfmt.Println(name)\n}\n')
      const greet = (file: string) => workflow({
        in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'name', type: 'string' }] },
        say: { type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: file }, inputs: [{ name: 'name', type: 'string' }] },
      }, ['in:name>say:name'], { name: 'hello', kind: 'code', language: 'go', atomFolder: folder })

      await assert.rejects(controller.save(JSON.stringify(greet('gone.go'))), /写不出 .*workflow\.go，工作流未保存/)
      assert.deepEqual(JSON.parse(controller.snapshot()).workflows, [])

      await controller.save(JSON.stringify(greet('greet.go')))
      assert.equal(await readFile(join(folder, 'workflow.go'), 'utf8'), [
        '// Code generated from workflow "hello". DO NOT EDIT.',
        '',
        'package hello',
        '',
        'func hello(name string) {',
        '\tGreet(name)',
        '}',
        '',
      ].join('\n'))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
