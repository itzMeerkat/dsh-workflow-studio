/**
 * 内置节点单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { BUILTIN_NODES, registerBuiltinNodes } from '../src/basic-nodes.ts'
import type { NodeExecutionContext } from '../src/types.ts'
import { RunId } from '../src/types.ts'

function buildCtx(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    runId: RunId('test'),
    config: {},
    inputs: {},
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  }
}

describe('input 节点', () => {
  const node = BUILTIN_NODES.find(n => n.type === 'input')!

  it('应使用配置的默认值', () => {
    const result = node.execute(buildCtx({ config: { defaultValue: 42 } }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.output, 42)
  })

  it('无默认值时返回 0', () => {
    const result = node.execute(buildCtx({ config: {} }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.output, 0)
  })

  it('非法默认值应明确失败', () => {
    const result = node.execute(buildCtx({ config: { defaultValue: '42' } }))
    assert.deepEqual(result, { status: 'failed', error: 'defaultValue 必须为有限数值' })
  })
})

describe('arithmetic 节点', () => {
  const node = BUILTIN_NODES.find(n => n.type === 'arithmetic')!

  it('应正确执行加法', () => {
    const result = node.execute(buildCtx({
      config: { operator: 'add' },
      inputs: { left: 10, right: 20 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.result, 30)
  })

  it('应正确执行除法', () => {
    const result = node.execute(buildCtx({
      config: { operator: 'divide' },
      inputs: { left: 10, right: 2 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.result, 5)
  })

  it('除零应返回明确错误', () => {
    const result = node.execute(buildCtx({
      config: { operator: 'divide' },
      inputs: { left: 10, right: 0 },
    }))
    assert.deepEqual(result, { status: 'failed', error: '除数不能为 0' })
  })

  it('缺少操作数时不应默认补 0', () => {
    const result = node.execute(buildCtx({
      config: { operator: 'add' },
      inputs: { left: 10 },
    }))
    assert.equal(result.status, 'failed')
  })
})

describe('if 节点', () => {
  const node = BUILTIN_NODES.find(n => n.type === 'if')!

  it('表达式为 true 时只产生 true 门控信号', () => {
    const result = node.execute(buildCtx({
      config: { expression: 'left > right && right > 0' },
      inputs: { left: 3, right: 2 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') {
      assert.deepEqual(result.outputs, { true: true })
    }
  })

  it('表达式为 false 时只产生 false 门控信号', () => {
    const result = node.execute(buildCtx({
      config: { expression: 'left === right' },
      inputs: { left: 'a', right: 'b' },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') {
      assert.deepEqual(result.outputs, { false: true })
    }
  })

  it('支持属性访问和三元表达式', () => {
    const result = node.execute(buildCtx({
      config: { expression: 'left.score >= right ? true : false' },
      inputs: { left: { score: 10 }, right: 8 },
    }))
    assert.deepEqual(result, { status: 'completed', outputs: { true: true } })
  })

  it('拒绝语法错误和非布尔结果', () => {
    const invalid = node.execute(buildCtx({
      config: { expression: 'left >' },
      inputs: { left: 1, right: 0 },
    }))
    assert.equal(invalid.status, 'failed')
    if (invalid.status === 'failed') assert.match(invalid.error, /expression 执行失败/)

    assert.deepEqual(
      node.execute(buildCtx({
        config: { expression: 'left + right' },
        inputs: { left: 1, right: 2 },
      })),
      { status: 'failed', error: 'expression 必须返回布尔值' },
    )
  })

  it('不允许通过表达式调用对象构造器', () => {
    const result = node.execute(buildCtx({
      config: { expression: 'left.constructor.constructor("return process")()' },
      inputs: { left: {}, right: null },
    }))
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.match(result.error, /expression 执行失败/)
  })
})

describe('coalesce 节点', () => {
  const node = BUILTIN_NODES.find(n => n.type === 'coalesce')!

  it('返回唯一的非 null 输入', () => {
    const result = node.execute(buildCtx({
      inputs: { first: null, second: 'selected' },
    }))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'selected' } })
  })

  it('未连接输入不计入候选值', () => {
    const result = node.execute(buildCtx({
      inputs: { second: 'selected' },
    }))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'selected' } })
  })

  it('零个或多个非 null 输入应失败', () => {
    assert.deepEqual(
      node.execute(buildCtx({ inputs: { first: null, second: null } })),
      { status: 'failed', error: 'coalesce 要求恰好一个非 null 输入，实际为 0 个' },
    )
    assert.deepEqual(
      node.execute(buildCtx({ inputs: { first: 1, second: 2 } })),
      { status: 'failed', error: 'coalesce 要求恰好一个非 null 输入，实际为 2 个' },
    )
  })
})

describe('内置节点注册', () => {
  it('注册中途失败时回滚已注册节点', () => {
    const registered = new Set<string>()
    const ctx = {
      workflowNodeRegistry: {
        get: () => undefined,
        register: (node: { type: string }) => {
          if (node.type === 'arithmetic') throw new Error('planned registration failure')
          registered.add(node.type)
          return () => { registered.delete(node.type) }
        },
      },
    } as unknown as Context

    assert.throws(() => { registerBuiltinNodes(ctx) }, /planned registration failure/)
    assert.deepEqual([...registered], [])
  })
})
