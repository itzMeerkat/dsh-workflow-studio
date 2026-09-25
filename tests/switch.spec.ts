/**
 * 多路分支：执行引脚取自节点的 case，运行时触发值匹配的 case 或 default，code 工作流写成 if/else if/else。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { WorkflowStudioController } from '../src/controller.ts'
import { analyzeWorkflow, indexNodeTypes } from '../src/shared/analysis.ts'
import { CODE_BLOCK_TYPE, CODE_FIELD, GO } from '../src/shared/language.ts'
import { renderWorkflow } from '../src/shared/source.ts'
import { SWITCH_CASES, switchPin } from '../src/shared/switch.ts'
import { RunId } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { createFixtureNodes } from './fixture-nodes.ts'
import { CATALOG, NODE_TYPES, irOf, nodeType, workflow } from './graph-fixtures.ts'
import { TestHosts, runEnded } from './host.ts'

const sw = (...cases: string[]) => ({ type: 'switch', config: { [SWITCH_CASES]: cases } })

describe('多路分支', () => {
  it('字符串、数字和布尔值按文本匹配 case，都不匹配时为 default，其他值没有引脚', () => {
    assert.equal(switchPin(3, ['2', '3']), '3')
    assert.equal(switchPin(true, ['true']), 'true')
    assert.equal(switchPin('x', ['a']), 'default')
    assert.equal(switchPin({}, ['a']), undefined)
  })

  it('每个 case 是一个互斥的引脚：各 case 汇合到分支合并时恰好一个送达', () => {
    const definition = workflow({
      v: 'value', s: sw('a', 'b'), x: 'value', y: 'value', z: 'value', m: { type: 'merge', inputs: [
        { name: 'input1', type: 'any', required: false },
        { name: 'input2', type: 'any', required: false },
        { name: 'input3', type: 'any', required: false },
      ] },
    }, ['v>s:value', 's.a>x', 's.b>y', 's.default>z', 'x>m:input1', 'y>m:input2', 'z>m:input3', 'x.then>m', 'y.then>m', 'z.then>m'])
    assert.deepEqual(analyzeWorkflow(definition, CATALOG).diagnostics, [])
    const partial = { ...definition, edges: definition.edges.filter(edge => edge.source !== 'z' && edge.target !== 'z') }
    assert.deepEqual(analyzeWorkflow(partial, CATALOG).diagnostics.map(item => item.code), ['merge-gap'])
  })

  it('code 工作流写成 if/else if/else；字符串类型的 case 加引号', () => {
    const catalog = indexNodeTypes([
      ...NODE_TYPES.map(type => ({ ...type, kinds: ['run', 'code'] as const })),
      nodeType(CODE_BLOCK_TYPE, { kinds: ['code'] }),
    ])
    const block = (text: string) => ({ type: CODE_BLOCK_TYPE, config: { [CODE_FIELD]: text } })
    const definition = workflow({
      in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'kind', type: 'string' }] },
      s: sw('a', 'b'),
      x: block('println("a")'), y: block('println("b")'), z: block('println("?")'),
      only: sw('a'), w: block('println("not a")'),
    }, ['in:kind>s:value', 's.a>x', 's.b>y', 's.default>z', 'in:kind>only:value', 'only.default>w'], { kind: 'code', language: 'go' })
    assert.equal(renderWorkflow(irOf(definition, catalog), GO), [
      '// Code generated from workflow "test". DO NOT EDIT.',
      '',
      'func test(kind string) {',
      '\tif kind == "a" {',
      '\t\tprintln("a")',
      '\t} else if kind == "b" {',
      '\t\tprintln("b")',
      '\t} else {',
      '\t\tprintln("?")',
      '\t}',
      '\tif !(kind == "a") {',
      '\t\tprintln("not a")',
      '\t}',
      '}',
      '',
    ].join('\n'))
  })
})

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
    (JSON.parse(await controller.save(JSON.stringify(workflow({
      two: { type: 'value', config: { value: 2 } },
      s: sw(...cases),
      hit: { type: 'value', config: { value: 1 } },
      miss: { type: 'value', config: { value: 0 } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [] },
    }, ['two>s:value', `s.${pin}>hit`, 's.default>miss'], { name: 'switch' })))) as { workflowId: string }).workflowId

  it('触发值匹配的 case，其他引脚后的节点被跳过', async () => {
    const controller = await setup()
    const record = await runEnded(host, RunId(controller.start(await saved(controller, ['1', '2'], '2'))))
    assert.equal(record.status, 'completed')
    assert.deepEqual(record.nodes.filter(node => node.nodeId !== 'out').map(node => [node.nodeId, node.status]), [
      ['two', 'completed'], ['s', 'completed'], ['hit', 'completed'], ['miss', 'skipped'],
    ])
  })

  it('保存拒绝重复的 case，以及连到不是 case 的引脚的执行边', async () => {
    const controller = await setup()
    await assert.rejects(saved(controller, ['1', '1'], '1'), /case "1" 为空、重复或与 default 引脚同名/)
    await assert.rejects(saved(controller, ['1'], '2'), /不存在的执行输出引脚/)
  })
})
