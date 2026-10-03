/**
 * Browser Remote controller tests.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { createFixtureNodes } from './fixture-nodes.ts'
import { workflow } from './graph-fixtures.ts'
import { TestHosts, runEnded, signalRequested } from './host.ts'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATOM_FIELD, CODE_ATOM_TYPE } from '../src/shared/language.ts'
import { SUBWORKFLOW_FIELD, SUBWORKFLOW_TYPE } from '../src/shared/subworkflow.ts'
import { RunId, type DagWorkflowDefinition, type SavedWorkflow } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
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

  /** 保存结果中的工作流 ID。 */
  const idOf = (saved: SavedWorkflow): string => saved.workflowId

  /** 快照中第一个工作流保存下来的定义。 */
  function savedDefinition(controller: WorkflowStudioController): DagWorkflowDefinition {
    return controller.snapshot().workflows[0]!.definition
  }

  it('保存定义、列出节点并返回完整运行结果', async () => {
    const controller = await setup()
    const workflowId = idOf(await controller.save(workflow({
      left: { type: 'value', config: { value: 10 }, position: { x: 24, y: 48 } },
      right: { type: 'value', config: { value: 20 } },
      add: { type: 'sum', config: { offset: 0 } },
    }, ['left>add:left', 'right>add:right'], { name: 'sum' })))

    const snapshot = controller.snapshot()
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: workflowId, name: 'sum' }],
    )
    assert.deepEqual(
      snapshot.nodeTypes.map(node => node.type).sort(),
      [
        'ask', 'branch', 'code-atom', 'code-block', 'code-condition', 'greater', 'merge', 'subworkflow',
        'subworkflow-entry', 'subworkflow-exit', 'sum', 'switch', 'value', 'workflow-input', 'workflow-output',
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

    const result = await runEnded(host, RunId(controller.start(workflowId, {})))
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes.find(node => node.nodeId === 'add')?.outputs, { result: 30 })
  })

  it('保存的定义保留边界节点声明的端口和默认值', async () => {
    const controller = await setup()
    await controller.save(workflow({
      in: { type: 'workflow-input', outputs: [{ name: 'threshold', type: 'number', default: 3 }] },
      out: { type: 'workflow-output', inputs: [{ name: 'verdict', type: 'string', required: false }] },
    }, [], { name: 'declared' }))

    // A schema that does not declare `default` drops it, so the round trip is what proves it persists.
    assert.deepEqual(savedDefinition(controller).nodes.find(node => node.id === 'in')?.outputs, [
      { name: 'threshold', type: 'number', default: 3 },
    ])
  })

  it('等待中的请求经 signal Remote 校验后送达结果', async () => {
    const controller = await setup()
    const workflowId = idOf(await controller.save(
      workflow({ ask: 'ask' }, [], { name: 'ask' }),
    ))
    const asked = signalRequested(host)
    const runId = RunId(controller.start(workflowId, {}))
    await asked
    const pending = controller.getRun(runId).nodes[0]!
    assert.equal(pending.status, 'running')
    assert.deepEqual(pending.requests?.map(item => [item.id, (item.request as { kind: string }).kind]), [['pick', 'questions']])

    await assert.rejects(
      controller.signal(runId, 'ask', 'pick', { answers: [] }),
      /缺少问题 "decision"/,
    )
    const answer = { answers: [{ id: 'decision', selected: ['yes'] }] }
    const after = await controller.signal(runId, 'ask', 'pick', answer)
    assert.deepEqual(after.nodes[0]?.requests?.[0]?.result, answer)

    const result = await runEnded(host, runId)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes[0]?.outputs, { answer: 'yes' })
  })

  it('按 ID 更新返回改名后的新 ID，快照只列出改名后的工作流', async () => {
    const controller = await setup()
    const source = workflow({ input: { type: 'value', config: { value: 1 } } }, [], { name: 'before' })
    assert.equal(idOf(await controller.save(source)), 'before')

    const renamed = idOf(await controller.update('before', { ...source, name: 'after' }))

    assert.equal(renamed, 'after')
    const snapshot = controller.snapshot()
    assert.deepEqual(
      snapshot.workflows.map(({ id, name }) => ({ id, name })),
      [{ id: 'after', name: 'after' }],
    )
  })

  it('快照含两种工作流和各自可用的节点类型，名称不跨种类复用，种类不能改变，code 工作流不能运行', async () => {
    const controller = await setup()
    const run = workflow({ input: { type: 'value', config: { value: 1 } } }, [], { name: 'shared' })
    const code = workflow({}, [], { name: 'shared', kind: 'code', language: 'go' })
    await controller.save(run)
    await controller.save({ ...code, name: 'compiled' })

    const snapshot = controller.snapshot()
    assert.deepEqual(
      snapshot.workflows.map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id)),
      [{ id: 'compiled', kind: 'code' }, { id: 'shared', kind: 'run' }],
    )
    const kindsOf = (type: string) => snapshot.nodeTypes.find(item => item.type === type)?.kinds
    assert.deepEqual(kindsOf('code-atom'), ['code'])
    assert.deepEqual(kindsOf('sum'), ['run'])
    assert.deepEqual(kindsOf('branch'), ['run', 'code'])

    await assert.rejects(controller.save(code), /名称 "shared" 已被一个 run 工作流使用/)
    await assert.rejects(controller.update('shared', { ...code, nodes: [] }), /是 run 工作流，不能改为 code 工作流/)
    assert.throws(() => controller.start('compiled', {}), /是 code 工作流，只写成源码，不能运行/)
  })

  it('watchRuns 先给出当前的运行列表，运行变化时再给出新的列表，取消后结束', async () => {
    const controller = await setup()
    const workflowId = idOf(await controller.save(workflow({ v: { type: 'value', config: { value: 1 } } }, [], { name: 'watched' })))
    const watching = new AbortController()
    const lists: string[][] = []
    const watch = (async () => {
      for await (const list of controller.watchRuns(watching.signal)) {
        lists.push(list.map(run => run.status))
        if (list[0]?.status === 'completed') watching.abort()
      }
    })()
    await new Promise(resolve => setImmediate(resolve))
    controller.start(workflowId, {})
    await watch

    assert.deepEqual(lists[0], [])
    assert.deepEqual(lists.at(-1), ['completed'])
  })

  it('作者能改正的拒绝带着类别报告，不合 schema 的值是错误请求，其余是意外', async () => {
    const controller = await setup()
    await assert.rejects(controller.save({ name: 'no-graph' }), { code: 'gateway/bad-request', message: /nodes/ })
    await assert.rejects(controller.save(workflow({ node: 'missing' }, [], { name: 'bad' })), {
      code: 'workflowStudio/refused',
      message: '未知节点类型: missing',
      details: { refusal: { code: 'node-type-unknown', type: 'missing' } },
    })
    assert.throws(() => controller.getRun('gone'), { code: 'workflowStudio/refused', details: { refusal: { code: 'run-missing', run: 'gone' } } })
    await assert.rejects(controller.folders('/no/such/folder'), {
      code: 'workflowStudio/refused',
      details: { refusal: { code: 'folder-unreadable', folder: '/no/such/folder', reason: "ENOENT: no such file or directory, scandir '/no/such/folder'" } },
    })
    // 引擎关闭后的写入失败不是作者能改正的，所以不带拒绝的类别，交给 Gateway 报告为内部错误。
    await hosts.stop(host)
    await assert.rejects(controller.save(workflow({ v: 'value' }, [], { name: 'late' })), (error: unknown) =>
      error instanceof Error && remoteErrorOf(error) === undefined)
  })

  it('保存带原子目录的 Go 工作流时写出目录中的 <ID>.workflow.go，改名时换掉旧文件，删除时删掉；写不出时照样保存并给出原因', async () => {
    const controller = await setup()
    const folder = await mkdtemp(join(tmpdir(), 'atoms-'))
    try {
      await writeFile(join(folder, 'greet.go'), 'package hello\n\nimport "fmt"\n\nfunc Greet(name string) {\n\tfmt.Println(name)\n}\n')
      const greet = (file: string) => workflow({
        in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'name', type: 'string' }] },
        say: { type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: file }, inputs: [{ name: 'name', type: 'string' }] },
      }, ['in:name>say:name'], { name: 'hello', kind: 'code', language: 'go', atomFolder: folder })

      assert.match((await controller.save(greet('gone.go'))).sourceError ?? '', /gone\.go/)
      assert.deepEqual(await readdir(folder), ['greet.go'])

      await controller.save(greet('greet.go'))
      assert.equal(await readFile(join(folder, 'hello.workflow.go'), 'utf8'), [
        '// Code generated from workflow "hello". DO NOT EDIT.',
        '',
        'package hello',
        '',
        'func hello(name string) (err error) {',
        '\tGreet(name)',
        '\treturn',
        '}',
        '',
      ].join('\n'))

      // 嵌入它的工作流按它的签名调用它，所以它的签名一变，嵌入方的文件随之重写；写不出时删除并给出原因。
      await controller.save(workflow({
        in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'name', type: 'string' }] },
        sub: { type: SUBWORKFLOW_TYPE, config: { [SUBWORKFLOW_FIELD]: 'hello' }, inputs: [{ name: 'name', type: 'string' }] },
      }, ['in:name>sub:name'], { name: 'outer', kind: 'code', language: 'go', atomFolder: folder }))
      assert.match(await readFile(join(folder, 'outer.workflow.go'), 'utf8'), /err = hello\(name\)/)
      const widened = greet('greet.go')
      widened.nodes[0]!.outputs!.push({ name: 'greeting', type: 'string' })
      const saved = await controller.update('hello', widened) as SavedWorkflow
      assert.deepEqual(saved.embedderErrors?.map(({ name }) => name), ['outer'])
      assert.deepEqual((await readdir(folder)).sort(), ['greet.go', 'hello.workflow.go'])
      await assert.rejects(controller.delete('hello'), /被 "outer" 作为子工作流嵌入，不能删除/)
      await controller.save(greet('greet.go'))

      // 改名后文件随新 ID 改名，旧文件不再留在包里。
      await controller.save(workflow({}, [], { name: 'outer', kind: 'code', language: 'go', atomFolder: folder }))
      await controller.update('hello', { ...greet('greet.go'), name: 'greeting' })
      assert.deepEqual((await readdir(folder)).sort(), ['greet.go', 'greeting.workflow.go', 'outer.workflow.go'])

      // 删除工作流同时删除它的文件。
      await controller.delete('greeting')
      assert.deepEqual((await readdir(folder)).sort(), ['greet.go', 'outer.workflow.go'])
      assert.deepEqual((controller.snapshot()).workflows.map(({ id }) => id), ['outer'])
      await assert.rejects(controller.delete('greeting'), /不存在/)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('同时到达的保存逐个执行，换了两次原子目录的工作流只在最后一个目录留下文件', async () => {
    const controller = await setup()
    const folders = await Promise.all([1, 2, 3].map(async () => mkdtemp(join(tmpdir(), 'dsh-workflow-files-'))))
    const moved = (folder: string): DagWorkflowDefinition => workflow({}, [], { name: 'mover', kind: 'code', language: 'go', atomFolder: folder })
    try {
      await controller.save(moved(folders[0]!))
      await Promise.all([controller.update('mover', moved(folders[1]!)), controller.update('mover', moved(folders[2]!))])
      assert.deepEqual(await Promise.all(folders.map(async folder => readdir(folder))), [[], [], ['mover.workflow.go']])
    } finally {
      await Promise.all(folders.map(async folder => rm(folder, { recursive: true, force: true })))
    }
  })
})
