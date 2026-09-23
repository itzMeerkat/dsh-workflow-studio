/**
 * 语言单元测试：Go 签名、原子文件与导入名的读法，以及原子节点的端口随原子变化。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { goAtom, goImportName, goSignature } from '../src/shared/go.ts'
import { ATOM_FIELD, CODE_ATOM_TYPE, GO, atomLibrary, languageOf, withSignatures } from '../src/shared/language.ts'
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

  it('原子文件：唯一的函数连同导入和全局声明，字符串里的关键字不算声明', () => {
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
      '// Discount prices an order.',
      'var Discount = func(order Order) (price float64) {',
      '\tnote := `',
      'func Fake() {}',
      '`',
      '\t_ = str.TrimSpace(note)',
      '\treturn order.Total * rate',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(goAtom('discount.go', text), {
      file: 'discount.go',
      package: 'pricing',
      imports: ['"fmt"', 'str "strings"'],
      globals: [
        '// rate is the discount rate.\nvar rate = 0.9',
        'type Order struct{ Total float64 }',
        'func (o Order) Label() string { return fmt.Sprint(o.Total) }',
      ],
      code: text.slice(text.indexOf('// Discount'), text.lastIndexOf('}') + 1),
      signature: {
        name: 'Discount',
        parameters: [{ name: 'order', type: 'Order', port: 'any', optional: false }],
        results: [{ name: 'price', type: 'float64', port: 'number', optional: false }],
      },
    })
    assert.deepEqual(goAtom('none.go', 'package p\n\nvar x = 1\n'), { file: 'none.go', fault: 'no-function' })
    assert.deepEqual(goAtom('two.go', 'package p\n\nfunc A() {}\n\nfunc B() {}\n'), { file: 'two.go', fault: 'several-functions' })
  })

  it('原子节点的端口来自原子目录，签名变化时去掉接在消失端口上的边，原子不在目录中时端口不变', () => {
    const read = (text: string) => atomLibrary([
      { file: 'a.go', text: `package p\n\n${text}\n` },
      { file: 'b.go', text: 'package p\n' },
    ], GO.functions!.atoms!)
    const library = read('func Fetch(url string, retries *int) (body string, err error) { return "", nil }')
    assert.deepEqual(library.faults, [{ file: 'b.go', fault: 'no-function' }])
    const node = { type: CODE_ATOM_TYPE, config: { [ATOM_FIELD]: 'a.go' } }
    const definition = workflow({
      fetch: node,
      gone: { ...node, config: { [ATOM_FIELD]: 'gone.go' } },
      out: { type: WORKFLOW_OUTPUT_TYPE, inputs: [{ name: 'body', type: 'string' }, { name: 'err', type: 'any' }] },
    }, ['fetch:body>out:body', 'fetch:err>out:err'], { kind: 'code', language: GO.name })
    const signed = withSignatures(definition, library.atoms)
    assert.deepEqual(signed.nodes[0]?.inputs, [{ name: 'url', type: 'string' }, { name: 'retries', type: 'number', required: false }])
    assert.deepEqual(signed.nodes[0]?.outputs, [{ name: 'body', type: 'string' }, { name: 'err', type: 'any' }])
    assert.equal(signed.nodes[1]?.inputs, undefined)

    const renamed = withSignatures(signed, read('func Fetch(url string) (text string, err error) { return "", nil }').atoms)
    assert.deepEqual(renamed.edges.map(edge => edge.id), ['e1'])
  })

})
