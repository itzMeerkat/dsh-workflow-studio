/**
 * 语言单元测试：Go 签名的读法，以及函数节点的端口随代码变化。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { goSignature } from '../src/shared/go.ts'
import { CODE_FIELD, CODE_FUNCTION_TYPE, GO, languageOf, withSignatures } from '../src/shared/language.ts'
import { WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { workflow } from './graph-fixtures.ts'

describe('Go 签名', () => {
  it('分组的参数共用其后的类型，没有名字的项按位置命名，括号内的逗号不拆开，指针可选', () => {
    assert.deepEqual(goSignature('func(a, b int, f func(x, y int) bool, c chan string, limit *int) (*string, error) {\n\treturn nil, nil\n}'), {
      parameters: [
        { name: 'a', type: 'int', port: 'number', optional: false },
        { name: 'b', type: 'int', port: 'number', optional: false },
        { name: 'f', type: 'func(x, y int) bool', port: 'any', optional: false },
        { name: 'c', type: 'chan string', port: 'any', optional: false },
        { name: 'limit', type: '*int', port: 'number', optional: true },
      ],
      results: [
        { name: 'output1', type: '*string', port: 'string', optional: true },
        { name: 'output2', type: 'error', port: 'any', optional: false },
      ],
    })
    assert.deepEqual(goSignature('  func Check(chan int) interface{ Ok() bool } { return nil }'), {
      name: 'Check',
      parameters: [{ name: 'input', type: 'chan int', port: 'any', optional: false }],
      results: [{ name: 'output', type: 'interface{ Ok() bool }', port: 'any', optional: false }],
    })
    assert.equal(goSignature('x := 1'), undefined)
    assert.equal(goSignature('func(a int'), undefined)
  })

  it('函数节点的端口跟随代码，接在消失端口上的边被去掉，读不出签名时端口不变', () => {
    const edit = (text: string) => ({ type: CODE_FUNCTION_TYPE, config: { [CODE_FIELD]: text } })
    const wired = withSignatures(workflow({
      fn: edit('func(amount float64, discount *float64) (price float64, ok bool) {}'),
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'price', type: 'number' }, { name: 'ok', type: 'boolean' }] },
    }, ['fn:price>out:price', 'fn:ok>out:ok'], { kind: 'code', language: GO.name }))
    assert.deepEqual(wired.nodes[0]?.inputs, [{ name: 'amount', type: 'number' }, { name: 'discount', type: 'number', required: false }])
    assert.deepEqual(wired.nodes[0]?.outputs, [{ name: 'price', type: 'number' }, { name: 'ok', type: 'boolean' }])

    const renamed = withSignatures({ ...wired, nodes: [{ ...wired.nodes[0]!, ...edit('func(amount float64) (total float64, ok bool) {}') }, wired.nodes[1]!] })
    assert.deepEqual(renamed.edges.map(edge => edge.id), ['e1'])

    const typing = withSignatures({ ...wired, nodes: [{ ...wired.nodes[0]!, ...edit('func(amount') }, wired.nodes[1]!] })
    assert.deepEqual(typing.nodes[0]?.outputs, wired.nodes[0]?.outputs)
    assert.equal(typing.edges.length, 2)
  })

  it('code 工作流必须指定一种代码语言', () => {
    assert.throws(() => languageOf({ kind: 'code' }), /python、typescript、go 之一/)
    assert.equal(languageOf({ kind: 'code', language: 'go' }), GO)
  })
})
