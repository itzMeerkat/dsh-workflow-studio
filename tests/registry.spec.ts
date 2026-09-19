/**
 * 节点注册表单元测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import type { WorkflowNodeExecutor } from '../src/types.ts'

describe('WorkflowNodeRegistry', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('register() 应添加执行器，get() 应返回', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    const executor: WorkflowNodeExecutor = {
      type: 'test-node',
      label: 'Test',
      description: 'Test node',
      execute() { return { status: 'completed', outputs: {} } },
    }
    reg.register(executor, 'test-plugin')
    assert.equal(reg.get('test-node'), executor)
  })

  it('register() 重复类型应抛出', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    const executor: WorkflowNodeExecutor = {
      type: 'dup',
      label: 'Dup',
      description: 'Duplicate test',
      execute() { return { status: 'completed', outputs: {} } },
    }
    reg.register(executor, 'test-plugin')
    assert.throws(() => reg.register(executor, 'test-plugin'), /已注册/)
  })

  it('register() 要求来源插件名', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    assert.throws(
      () => reg.register({
        type: 'missing-source',
        label: 'Missing source',
        description: 'Invalid registration',
        execute() { return { status: 'completed', outputs: {} } },
      }, '  '),
      /来源插件名不能为空/,
    )
  })

  it('register() 返回的 disposer 应移除执行器', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    const executor: WorkflowNodeExecutor = {
      type: 'disposable',
      label: 'Disposable',
      description: 'Disposable test',
      execute() { return { status: 'completed', outputs: {} } },
    }
    const dispose = reg.register(executor, 'test-plugin')
    assert.ok(reg.get('disposable') !== undefined)
    dispose()
    assert.equal(reg.get('disposable'), undefined)
  })

  it('get() 未注册类型应返回 undefined', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    assert.equal(reg.get('nonexistent'), undefined)
  })

  it('listTypes() 应返回所有已注册节点的摘要', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    reg.register({
      type: 'type-a',
      label: 'A',
      description: 'Node A',
      execute() { return { status: 'completed', outputs: {} } },
    }, 'plugin-a')
    reg.register({
      type: 'type-b',
      label: 'B',
      description: 'Node B with ports',
      inputs: [{ name: 'x', type: 'number' }],
      outputs: [{ name: 'y', type: 'number' }],
      controls: [{ name: 'factor', label: 'Factor', kind: 'number', defaultValue: 1 }],
      requiresHumanInput: true,
      execute() { return { status: 'completed', outputs: { y: 1 } } },
    }, 'plugin-b')

    const types = reg.listTypes()
    assert.equal(types.length, 2)

    const a = types.find(t => t.type === 'type-a')
    assert.ok(a !== undefined)
    assert.equal(a.label, 'A')
    assert.equal(a.sourcePlugin, 'plugin-a')
    assert.deepEqual(a.inputs.map(port => port.name), ['condition'])
    assert.deepEqual(a.outputs, [])

    const b = types.find(t => t.type === 'type-b')
    assert.ok(b !== undefined)
    assert.equal(b.requiresHumanInput, true)
    assert.equal(b.sourcePlugin, 'plugin-b')
    assert.deepEqual(b.inputs.map(port => port.name), ['x', 'condition'])
    assert.deepEqual(b.outputs.map(port => port.name), ['y'])
    assert.deepEqual(b.controls.map(control => control.name), ['factor'])
  })

  it('保留普通节点的 condition 端口并允许流程控制节点退出门控', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    assert.throws(
      () => reg.register({
        type: 'bad-condition',
        label: 'Bad',
        description: 'Conflicts with engine port',
        inputs: [{ name: 'condition', type: 'boolean' }],
        execute: () => ({ status: 'completed', outputs: {} }),
      }, 'test-plugin'),
      /condition 由引擎保留/,
    )

    reg.register({
      type: 'control-node',
      label: 'Control',
      description: 'Owns its condition input',
      acceptsCondition: false,
      inputs: [{ name: 'condition', type: 'boolean' }],
      execute: () => ({ status: 'completed', outputs: {} }),
    }, 'test-plugin')
    assert.deepEqual(reg.listTypes()[0]?.inputs.map(port => port.name), ['condition'])
    assert.equal(reg.listTypes()[0]?.acceptsCondition, false)
  })

  it('旧 disposer 不应删除后续同类型注册', () => {
    ctx = new Context()
    const reg = new WorkflowNodeRegistry(ctx)
    const first: WorkflowNodeExecutor = {
      type: 'replaceable',
      label: 'First',
      description: 'First registration',
      execute: () => ({ status: 'completed', outputs: {} }),
    }
    const second: WorkflowNodeExecutor = {
      type: 'replaceable',
      label: 'Second',
      description: 'Second registration',
      execute: () => ({ status: 'completed', outputs: {} }),
    }

    const disposeFirst = reg.register(first, 'first-plugin')
    disposeFirst()
    reg.register(second, 'second-plugin')
    disposeFirst()

    assert.equal(reg.get('replaceable'), second)
  })
})
