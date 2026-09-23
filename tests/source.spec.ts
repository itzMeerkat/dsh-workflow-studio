/**
 * 源码生成单元测试：同一次遍历写出 run 工作流的伪代码和 code 工作流的目标语言。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { indexNodeTypes } from '../src/shared/analysis.ts'
import {
  ATOM_FIELD, CODE_ATOM_TYPE, CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, CODE_FIELD, GO, PSEUDOCODE, PYTHON,
  TYPESCRIPT, atomLibrary, withSignatures, type Language,
} from '../src/shared/language.ts'
import { RenderError, renderWorkflow } from '../src/shared/source.ts'
import { NodeId, type DagWorkflowDefinition } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { NODE_TYPES, irOf, nodeType, workflow } from './graph-fixtures.ts'

const code = (text: string) => ({ config: { [CODE_FIELD]: text } })

const CODE_CATALOG = indexNodeTypes([
  ...NODE_TYPES.map(type => ({ ...type, kinds: ['run', 'code'] as const })),
  nodeType(CODE_BLOCK_TYPE, { kinds: ['code'] }),
  nodeType(CODE_CONDITION_TYPE, { kinds: ['code'], outputs: [{ name: 'value', type: 'boolean' }] }),
  nodeType(CODE_ATOM_TYPE, { kinds: ['code'] }),
])

/** 超额时打折，否则原价，两条分支之后继续。 */
function discount(): DagWorkflowDefinition {
  return workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    over: { type: CODE_CONDITION_TYPE, ...code('amount > 100') },
    gate: 'branch',
    cut: { type: CODE_BLOCK_TYPE, ...code('\n    price = amount * 0.9\n    log("discount")\n') },
    keep: { type: CODE_BLOCK_TYPE, ...code('price = amount') },
    join: 'merge',
    report: { type: CODE_BLOCK_TYPE, ...code('log(price)') },
  }, [
    'over:value>gate:condition', 'gate.true>cut', 'gate.false>keep', 'cut.then>join', 'keep.then>join', 'join.then>report',
  ], { name: '折扣', kind: 'code' })
}

const compile = (definition: DagWorkflowDefinition, language: Language) =>
  renderWorkflow(irOf(definition, CODE_CATALOG), language)

describe('run 工作流写成伪代码', () => {
  it('节点写成调用，实参写出来源，决策节点的两侧写成 if/else，同名节点退回节点 ID', () => {
    const branching = workflow(
      { cond: 'flag', b: 'branch', yes: 'value', no: 'value', m: 'merge', out: 'sink' },
      ['cond>b:condition', 'b.true>yes', 'b.false>no', 'yes.then>m', 'no.then>m', 'yes>m:input1', 'no>m:input2', 'm>out'],
    )
    assert.equal(renderWorkflow(irOf(branching), PSEUDOCODE), [
      'workflow test():',
      '  flag = flag()',
      '  branch(condition: flag)',
      '  if branch.true:',
      '    yes = value()',
      '  else:',
      '    no = value()',
      '  merge = merge(input1: yes, input2: no)',
      '  sink(input: merge)',
      '',
    ].join('\n'))
  })

  it('工作流输入成为参数，输出写成赋值，标签作为名字', () => {
    const bounded = workflow({
      in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
      calc: { type: 'double', label: '小计' },
      gate: { type: 'branch', label: '是否超额' },
      cond: 'flag',
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'total', type: 'number', required: false }] },
    }, ['in:amount>calc', 'cond>gate:condition', 'gate.true>out', 'calc>out:total'], { name: 'Daily Report' })
    assert.equal(renderWorkflow(irOf(bounded), PSEUDOCODE), [
      'workflow Daily_Report(amount):',
      '  flag = flag()',
      '  小计 = double(input: amount)',
      '  是否超额: branch(condition: flag)',
      '  if 是否超额.true:',
      '    out: total = 小计',
      '',
    ].join('\n'))
  })
})

describe('code 工作流写成它的语言', () => {
  it('语句原样写出并按所在的块重新缩进，条件写进 if，块的开合由语言决定', () => {
    assert.equal(compile(discount(), PYTHON), [
      '# Code generated from workflow "折扣". DO NOT EDIT.',
      '',
      'def 折扣(amount):',
      '    if amount > 100:',
      '        price = amount * 0.9',
      '        log("discount")',
      '    else:',
      '        price = amount',
      '    log(price)',
      '',
    ].join('\n'))
    assert.equal(compile(discount(), TYPESCRIPT), [
      '// Code generated from workflow "折扣". DO NOT EDIT.',
      '',
      'export function 折扣(amount) {',
      '  if (amount > 100) {',
      '    price = amount * 0.9',
      '    log("discount")',
      '  } else {',
      '    price = amount',
      '  }',
      '  log(price)',
      '}',
      '',
    ].join('\n'))
  })

  it('只有另一侧的分支写成取反的条件，空块写成语言要求的占位', () => {
    const definition = workflow({
      over: { type: CODE_CONDITION_TYPE, ...code('amount > 100') },
      gate: 'branch',
      keep: { type: CODE_BLOCK_TYPE, ...code('') },
    }, ['over:value>gate:condition', 'gate.false>keep'], { name: 'one-sided', kind: 'code' })
    assert.match(compile(definition, PYTHON), /\n {4}if not \(amount > 100\):\n {8}pass\n$/)
  })

  it('条件接自工作流输入时就是那个参数', () => {
    const definition = workflow({
      in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'def', type: 'boolean' }] },
      gate: 'branch',
      body: { type: CODE_BLOCK_TYPE, ...code('go()') },
    }, ['in:def>gate:condition', 'gate.true>body'], { name: 'flagged', kind: 'code' })
    // `def` 是保留字，因此参数换成序号名，条件跟着引用它。
    assert.match(compile(definition, PYTHON), /def flagged\(arg2\):\n {4}if arg2:\n {8}go\(\)/)
  })

  it('Go 只写出工作流函数：按名字调用原子，被读的结果先声明，分支合并共用一个变量，只导入函数写到的包', () => {
    assert.equal(renderWorkflow(irOf(goDiscount(), CODE_CATALOG), GO, SHOP.atoms), [
      '// Code generated from workflow "折扣". DO NOT EDIT.',
      '',
      'package shop',
      '',
      'import (',
      '\t"time"',
      ')',
      '',
      'func 折扣(amount float64) (price float64, delay time.Duration) {',
      '\tvar Over_output bool',
      '\tvar join_output float64',
      '\tvar Wait_delay time.Duration',
      '\tOver_output = Over(amount)',
      '\tif Over_output {',
      '\t\tjoin_output, _ = Cut(amount)',
      '\t} else {',
      '\t\tjoin_output = Keep(amount, nil)',
      '\t}',
      '\tWait_delay = Wait(join_output)',
      '\tprice = join_output',
      '\tdelay = Wait_delay',
      '\treturn',
      '}',
      '',
    ].join('\n'))
  })

  it('写不出时指出要改的节点', () => {
    const fault = (definition: DagWorkflowDefinition, language: Language, atoms = SHOP.atoms) => {
      try {
        renderWorkflow(irOf(definition, CODE_CATALOG), language, atoms)
      } catch (error: unknown) {
        if (error instanceof RenderError) return error.fault
        throw error
      }
      return undefined
    }
    const unwired = discount()
    unwired.edges = unwired.edges.filter(edge => edge.target !== NodeId('gate') || edge.kind !== 'data')
    assert.deepEqual(fault(unwired, PYTHON), { code: 'no-condition', node: 'gate' })

    const multiline = discount()
    multiline.nodes.find(node => node.id === NodeId('over'))!.config = { [CODE_FIELD]: 'a\nb' }
    assert.deepEqual(fault(multiline, PYTHON), { code: 'multiline-condition', node: 'over' })

    assert.deepEqual(fault(goDiscount(), GO, new Map()), { code: 'missing-atom', node: 'over', atom: 'over.go' })
    const parameterless = goDiscount()
    parameterless.edges = parameterless.edges.filter(edge => edge.target !== NodeId('keep'))
    assert.deepEqual(fault(parameterless, GO), { code: 'unwired-parameter', node: 'keep', port: 'amount' })
  })
})

/** 一个 Go 包形式的原子目录。 */
const SHOP = atomLibrary([
  { file: 'over.go', text: 'package shop\n\nconst limit = 100\n\nvar Over = func(amount float64) bool {\n\treturn amount > limit\n}\n' },
  {
    file: 'cut.go',
    text: 'package shop\n\nimport "math"\n\nfunc Cut(amount float64) (price float64, saved float64) {\n\treturn math.Round(amount * 0.9), amount * 0.1\n}\n',
  },
  {
    file: 'keep.go',
    text: 'package shop\n\nimport "fmt"\n\nfunc Keep(amount float64, floor *float64) float64 {\n\tfmt.Println(amount)\n\treturn amount\n}\n',
  },
  {
    file: 'wait.go',
    text: 'package shop\n\nimport "time"\n\nfunc Wait(price float64) (delay time.Duration) {\n\treturn time.Duration(price) * time.Millisecond\n}\n',
  },
], GO.functions!.atoms)

/** {@link discount} 的 Go 写法：每一步是原子目录中的一个原子，端口由它的签名给出。 */
function goDiscount(): DagWorkflowDefinition {
  const atom = (file: string) => ({ type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: file } })
  return withSignatures(workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    over: atom('over.go'),
    gate: 'branch',
    cut: atom('cut.go'),
    keep: atom('keep.go'),
    join: 'merge',
    wait: atom('wait.go'),
    out: {
      type: WORKFLOW_OUTPUT_TYPE,
      inputs: [{ name: 'price', type: 'number', required: false }, { name: 'delay', type: 'any', required: false }],
    },
  }, [
    'in:amount>over:amount', 'over>gate:condition', 'gate.true>cut', 'gate.false>keep', 'in:amount>cut:amount',
    'in:amount>keep:amount', 'cut:price>join:input1', 'keep>join:input2', 'cut.then>join', 'keep.then>join',
    'join>wait:price', 'join>out:price', 'wait:delay>out:delay',
  ], { name: '折扣', kind: 'code', language: GO.name, atomFolder: '/shop' }), SHOP.atoms)
}
