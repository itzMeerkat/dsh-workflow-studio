/**
 * 语言单元测试：Go 签名、原子文件与导入名的读法，以及原子节点的端口随原子变化。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { goAtom, goImportName, goSignature } from '../src/shared/go.ts'
import {
  ATOM_FIELD, CODE_ATOM_TYPE, GO, PSEUDOCODE, atomLibrary, atomTypes, isAtomFile, languageOf, typeName,
} from '../src/shared/language.ts'
import { withCallees } from '../src/shared/callees.ts'
import { WORKFLOW_OUTPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { workflow } from './graph-fixtures.ts'

describe('Go 签名', () => {
  it('端口类型是 Go 类型的写法：分组的参数共用其后的类型，没有名字的项按位置命名，指针参数可选', () => {
    assert.deepEqual(goSignature('func(a, b int, f func(x, y int) bool, c chan  string, limit *int, ok bool, v interface{}) (*Order, float64, error) {\n\treturn nil, 0, nil\n}'), {
      parameters: [
        { name: 'a', type: 'int', optional: false },
        { name: 'b', type: 'int', optional: false },
        { name: 'f', type: 'func(x, y int) bool', optional: false },
        { name: 'c', type: 'chan string', optional: false },
        { name: 'limit', type: '*int', optional: true },
        { name: 'ok', type: 'boolean', optional: false },
        { name: 'v', type: 'any', optional: false },
      ],
      results: [
        { name: 'output1', type: '*Order' },
        { name: 'output2', type: 'number' },
        { name: 'output3', type: 'error' },
      ],
    })
    assert.deepEqual(goSignature('  func Check(chan int) interface{ Ok() bool } { return nil }'), {
      name: 'Check',
      parameters: [{ name: 'input', type: 'chan int', optional: false }],
      results: [{ name: 'output', type: 'interface{ Ok() bool }' }],
    })
    assert.equal(goSignature('x := 1'), undefined)
    assert.equal(goSignature('func(a int'), undefined)
  })

  it('导入项的包名：别名优先，路径的最后一段去掉版本和 go 前后缀，空白与点导入没有包名', () => {
    assert.deepEqual(
      ['"net/http"', 'str "strings"', '"gopkg.in/yaml.v3"', '"github.com/jackc/pgx/v5"', '"github.com/mattn/go-sqlite3"', '_ "embed"', '. "math"']
        .map(goImportName),
      ['http', 'str', 'yaml', 'pgx', 'sqlite3', undefined, undefined],
    )
  })

  it('code 工作流必须指定一种代码语言', () => {
    assert.throws(() => languageOf({ kind: 'code' }), /go、python、typescript 之一/)
    assert.equal(languageOf({ kind: 'code', language: 'go' }), GO)
  })

  it('原子文件：唯一的导出函数连同包与导入，未导出的函数和字符串里的关键字不算', () => {
    const text = [
      '//go:build linux',
      '',
      'package pricing',
      '',
      'import (',
      '\t"fmt"',
      '\tstr "strings" // aliased',
      ')',
      '',
      '// rate is the discount rate.',
      'var rate = 0.9',
      '',
      'type Order struct{ Total float64 }',
      '',
      'func (o Order) Label() string { return fmt.Sprint(o.Total) }',
      '',
      'func round(price float64) float64 { return price }',
      '',
      'var scale = func(price float64) float64 { return price * rate }',
      '',
      '// Discount prices an order.',
      'var Discount = func(order Order) (price float64) {',
      '\tnote := `',
      'func Fake() {}',
      '`',
      '\t_ = str.TrimSpace(note)',
      '\treturn round(scale(order.Total))',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(goAtom('discount.go', text), {
      file: 'discount.go',
      package: 'pricing',
      imports: ['"fmt"', 'str "strings"'],
      signature: {
        name: 'Discount',
        parameters: [{ name: 'order', type: 'Order', optional: false }],
        results: [{ name: 'price', type: 'number' }],
      },
    })
    assert.deepEqual(goAtom('none.go', 'package p\n\nvar X = 1\n\nfunc helper() {}\n'), { file: 'none.go', fault: 'no-exported-function' })
    assert.deepEqual(goAtom('two.go', 'package p\n\nfunc A() {}\n\nvar B = func() {}\n'), {
      file: 'two.go',
      fault: 'several-exported-functions',
      names: ['A', 'B'],
    })
  })

  it('原子目录：types.go 与生成的 *.workflow.go 不是原子，测试文件不是原子文件', () => {
    const syntax = GO.functions!.atoms!
    assert.deepEqual(['a.go', 'a_test.go', 'types.go', 'checkout.workflow.go', 'notes.md'].map(file => isAtomFile(file, syntax)), [
      true, false, false, false, false,
    ])
    const library = atomLibrary([
      { file: 'a.go', text: 'package p\n\nfunc A(order Order) {}\n' },
      { file: 'types.go', text: 'package p\n\ntype Order struct{}\n' },
    ], syntax)
    assert.deepEqual([...library.atoms.keys()], ['a.go'])
    assert.equal(library.types, true)
    assert.equal(atomLibrary([{ file: 'a.go', text: 'package p\n\nfunc A() {}\n' }], syntax).types, false)
    assert.deepEqual(atomTypes(library), ['Order'])
  })

  it('端口类型按语言写出：Go 写内置类型的 Go 类型，其余类型原样，伪代码不改写', () => {
    assert.deepEqual(['number', 'boolean', 'any', 'Order', '*int'].map(type => typeName(GO, type)), ['float64', 'bool', 'any', 'Order', '*int'])
    assert.equal(typeName(PSEUDOCODE, 'number'), 'number')
  })

  it('原子节点的端口来自原子目录，签名变化时去掉接在消失端口上的边，原子不在目录中时端口不变', () => {
    const read = (text: string) => atomLibrary([
      { file: 'a.go', text: `package p\n\n${text}\n` },
      { file: 'b.go', text: 'package p\n' },
    ], GO.functions!.atoms!)
    const library = read('func Fetch(url string, retries *int) (body string, err error) { return "", nil }')
    assert.deepEqual(library.faults, [{ file: 'b.go', fault: 'no-exported-function' }])
    const node = { type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: 'a.go' } }
    const definition = workflow({
      fetch: node,
      gone: { ...node, config: { [ATOM_FIELD]: 'gone.go' } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'body', type: 'string' }, { name: 'err', type: 'error' }] },
    }, ['fetch:body>out:body', 'fetch:err>out:err'], { kind: 'code', language: GO.name })
    const signed = withCallees(definition, { atoms: library.atoms, workflows: new Map() })
    assert.deepEqual(signed.nodes[0]?.inputs, [{ name: 'url', type: 'string' }, { name: 'retries', type: '*int', required: false }])
    assert.deepEqual(signed.nodes[0]?.outputs, [{ name: 'body', type: 'string' }, { name: 'err', type: 'error' }])
    assert.equal(signed.nodes[1]?.inputs, undefined)

    const renamed = withCallees(signed, { atoms: read('func Fetch(url string) (text string, err error) { return "", nil }').atoms, workflows: new Map() })
    assert.deepEqual(renamed.edges.map(edge => edge.id), ['e1'])
  })

})
