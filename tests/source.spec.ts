/**
 * 源码生成单元测试：同一次遍历写出 run 工作流的伪代码和 code 工作流的目标语言。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { indexNodeTypes } from '../src/shared/analysis.ts'
import {
  ATOM_FIELD, CODE_ATOM_TYPE, CODE_BLOCK_TYPE, CODE_CONDITION_TYPE, CODE_FIELD, GO, PSEUDOCODE, atomLibrary,
} from '../src/shared/language.ts'
import { withCallees } from '../src/shared/callees.ts'
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

const compile = (definition: DagWorkflowDefinition) => renderWorkflow(irOf(definition, CODE_CATALOG), GO)

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
  it('语句原样写出并按所在的块重新缩进，条件写进 if', () => {
    assert.equal(compile(discount()), [
      '// Code generated from workflow "折扣". DO NOT EDIT.',
      '',
      'func 折扣(amount float64) (err error) {',
      '\tif amount > 100 {',
      '\t\tprice = amount * 0.9',
      '\t\tlog("discount")',
      '\t} else {',
      '\t\tprice = amount',
      '\t}',
      '\tlog(price)',
      '\treturn',
      '}',
      '',
    ].join('\n'))
  })

  it('只有另一侧的分支写成取反的条件', () => {
    const definition = workflow({
      over: { type: CODE_CONDITION_TYPE, ...code('amount > 100') },
      gate: 'branch',
      keep: { type: CODE_BLOCK_TYPE, ...code('') },
    }, ['over:value>gate:condition', 'gate.false>keep'], { name: 'one-sided', kind: 'code' })
    assert.match(compile(definition), /\n\tif !\(amount > 100\) \{\n\t\}\n/)
  })

  it('条件接自工作流输入时就是那个参数', () => {
    const definition = workflow({
      in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'func', type: 'boolean' }] },
      gate: 'branch',
      body: { type: CODE_BLOCK_TYPE, ...code('run()') },
    }, ['in:func>gate:condition', 'gate.true>body'], { name: 'flagged', kind: 'code' })
    // `func` 是保留字，因此参数换成序号名，条件跟着引用它。
    assert.match(compile(definition), /func flagged\(arg3 bool\) \(err error\) \{\n\tif arg3 \{\n\t\trun\(\)/)
  })

  it('Go 只写出工作流函数：类型取自端口，按名字调用原子，被读的结果先声明，分支合并共用一个变量，失败的原子带上名字提前返回错误，只导入函数写到的包', () => {
    assert.equal(renderWorkflow(irOf(goDiscount(), CODE_CATALOG), GO, { atoms: SHOP.atoms, workflows: new Map(), package: SHOP.package }), [
      '// Code generated from workflow "折扣". DO NOT EDIT.',
      '',
      'package shop',
      '',
      'import (',
      '\t"fmt"',
      '\t"time"',
      ')',
      '',
      'func 折扣(amount float64) (price float64, delay time.Duration, err error) {',
      '\tvar Over_output bool',
      '\tvar join_output float64',
      '\tvar Wait_delay time.Duration',
      '\tOver_output = Over(amount)',
      '\tif Over_output {',
      '\t\tjoin_output, _ = Cut(amount)',
      '\t} else {',
      '\t\tjoin_output = Keep(amount, nil)',
      '\t}',
      '\tWait_delay, err = Wait(join_output)',
      '\tif err != nil {',
      '\t\terr = fmt.Errorf("Wait: %w", err)',
      '\t\treturn',
      '\t}',
      '\tprice = join_output',
      '\tdelay = Wait_delay',
      '\treturn',
      '}',
      '',
    ].join('\n'))
  })

  it('代码节点的端口是以端口名为名的变量：输入先由数据边赋值，代码块写的输出供后面读，同名端口是同一个变量', () => {
    assert.equal(renderWorkflow(irOf(slowLabel(), CODE_CATALOG), GO, { atoms: SHOP.atoms, workflows: new Map(), package: SHOP.package }), [
      '// Code generated from workflow "Describe". DO NOT EDIT.',
      '',
      'package shop',
      '',
      'import (',
      '\t"fmt"',
      '\t"time"',
      ')',
      '',
      'func Describe(amount float64) (label string, err error) {',
      '\tvar Wait_delay time.Duration',
      '\tvar d time.Duration',
      '\tWait_delay, err = Wait(amount)',
      '\tif err != nil {',
      '\t\terr = fmt.Errorf("Wait: %w", err)',
      '\t\treturn',
      '\t}',
      '\td = Wait_delay',
      '\tif d > time.Second {',
      '\t\td = Wait_delay',
      '\t\tlabel = fmt.Sprint(amount, d)',
      '\t} else {',
      '\t\tlabel = "fast"',
      '\t}',
      '\treturn',
      '}',
      '',
    ].join('\n'))

    // 同名的端口类型不同，或端口名不能作为变量时，指出节点和端口。
    const retyped = slowLabel()
    retyped.nodes.find(node => node.id === NodeId('slow'))!.inputs = [{ name: 'd', type: 'number' }]
    assert.throws(() => renderWorkflow(irOf(retyped, CODE_CATALOG), GO, { atoms: SHOP.atoms, workflows: new Map() }),
      (error: unknown) => error instanceof RenderError && error.fault.code === 'port-variable' && error.fault.node === 'lazy')
    const keyword = slowLabel()
    keyword.nodes.find(node => node.id === NodeId('fast'))!.outputs = [{ name: 'func', type: 'string' }]
    keyword.edges = keyword.edges.map(edge => edge.source === NodeId('fast') && edge.kind === 'data' ? { ...edge, sourcePort: 'func' } : edge)
    assert.throws(() => renderWorkflow(irOf(keyword, CODE_CATALOG), GO, { atoms: SHOP.atoms, workflows: new Map() }),
      (error: unknown) => error instanceof RenderError && error.fault.code === 'port-variable' && error.fault.node === 'fast')
  })

  it('写不出时指出要改的节点', () => {
    const fault = (definition: DagWorkflowDefinition, atoms = SHOP.atoms) => {
      try {
        renderWorkflow(irOf(definition, CODE_CATALOG), GO, { atoms, workflows: new Map() })
      } catch (error: unknown) {
        if (error instanceof RenderError) return error.fault
        throw error
      }
      return undefined
    }
    const unwired = discount()
    unwired.edges = unwired.edges.filter(edge => edge.target !== NodeId('gate') || edge.kind !== 'data')
    assert.deepEqual(fault(unwired), { code: 'no-condition', node: 'gate' })

    const multiline = discount()
    multiline.nodes.find(node => node.id === NodeId('over'))!.config = { [CODE_FIELD]: 'a\nb' }
    assert.deepEqual(fault(multiline), { code: 'multiline-condition', node: 'over' })

    assert.deepEqual(fault(goDiscount(), new Map()), { code: 'missing-atom', node: 'over', atom: 'over.go' })
    const parameterless = goDiscount()
    parameterless.edges = parameterless.edges.filter(edge => edge.target !== NodeId('keep'))
    assert.deepEqual(fault(parameterless), { code: 'unwired-parameter', node: 'keep', port: 'amount' })
  })
})

/** 一个 Go 包形式的原子目录。 */
const SHOP = atomLibrary('/shop', [
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
    text: 'package shop\n\nimport "time"\n\nfunc Wait(price float64) (delay time.Duration, err error) {\n\treturn time.Duration(price) * time.Millisecond, nil\n}\n',
  },
], GO.functions.atoms)

/** {@link discount} 的 Go 写法：每一步是原子目录中的一个原子，端口由它的签名给出。 */
function goDiscount(): DagWorkflowDefinition {
  const atom = (file: string) => ({ type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: file } })
  return withCallees(workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    over: atom('over.go'),
    gate: 'branch',
    cut: atom('cut.go'),
    keep: atom('keep.go'),
    join: 'merge',
    wait: atom('wait.go'),
    out: {
      type: WORKFLOW_OUTPUT_TYPE,
      inputs: [{ name: 'price', type: 'number', required: false }, { name: 'delay', type: 'time.Duration', required: false }],
    },
  }, [
    'in:amount>over:amount', 'over>gate:condition', 'gate.true>cut', 'gate.false>keep', 'in:amount>cut:amount',
    'in:amount>keep:amount', 'cut:price>join:input1', 'keep>join:input2', 'cut.then>join', 'keep.then>join',
    'join>wait:price', 'join>out:price', 'wait:delay>out:delay',
  ], { name: '折扣', kind: 'code', language: GO.name, atomFolder: '/shop' }), { atoms: SHOP.atoms, workflows: new Map() })
}

/** 等待的时长超过一秒时写出金额和时长，否则写 `fast`；标签是工作流的结果。 */
function slowLabel(): DagWorkflowDefinition {
  return withCallees(workflow({
    in: { type: WORKFLOW_INPUT_TYPE, outputs: [{ name: 'amount', type: 'number' }] },
    wait: { type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: 'wait.go' } },
    slow: { type: CODE_CONDITION_TYPE, ...code('d > time.Second'), inputs: [{ name: 'd', type: 'time.Duration' }] },
    gate: 'branch',
    lazy: {
      type: CODE_BLOCK_TYPE,
      ...code('label = fmt.Sprint(amount, d)'),
      inputs: [{ name: 'amount', type: 'number' }, { name: 'd', type: 'time.Duration' }],
      outputs: [{ name: 'label', type: 'string' }],
    },
    fast: { type: CODE_BLOCK_TYPE, ...code('label = "fast"'), outputs: [{ name: 'label', type: 'string' }] },
    join: 'merge',
    out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'label', type: 'string', required: false }] },
  }, [
    'in:amount>wait:price', 'wait:delay>slow:d', 'slow:value>gate:condition', 'gate.true>lazy', 'gate.false>fast',
    'in:amount>lazy:amount', 'wait:delay>lazy:d', 'lazy:label>join:input1', 'fast:label>join:input2', 'lazy.then>join',
    'fast.then>join', 'join>out:label',
  ], { name: 'Describe', kind: 'code', language: GO.name, atomFolder: '/shop' }), { atoms: SHOP.atoms, workflows: new Map() })
}
