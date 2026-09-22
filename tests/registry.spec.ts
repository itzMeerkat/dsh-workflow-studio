/**
 * 节点注册表单元测试。
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry } from '../src/registry.ts'
import type { WorkflowNodeExecutor } from '../src/shared/types.ts'

/** 一个最小的执行器；`fields` 覆盖它的端口、控件等声明。 */
function executor(type: string, fields: Partial<WorkflowNodeExecutor> = {}): WorkflowNodeExecutor {
  return {
    type,
    label: type,
    description: `${type} node`,
    execute: () => ({ status: 'completed', outputs: {} }),
    ...fields,
  }
}

describe('WorkflowNodeRegistry', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  function registry(): WorkflowNodeRegistry {
    ctx = new Context()
    return new WorkflowNodeRegistry(ctx)
  }

  it('注册后可按类型取回，重复类型和空来源插件名被拒绝', () => {
    const reg = registry()
    const node = executor('test-node')
    reg.register(node, 'test-plugin')

    assert.equal(reg.get('test-node'), node)
    assert.equal(reg.get('nonexistent'), undefined)
    assert.throws(() => reg.register(node, 'test-plugin'), /已注册/)
    assert.throws(() => reg.register(executor('other'), '  '), /来源插件名不能为空/)
  })

  it('listTypes() 按声明原样列出端口、控件和来源插件，并拒绝重复端口名', () => {
    const reg = registry()
    reg.register(executor('type-a'), 'plugin-a')
    reg.register(executor('type-b', {
      inputs: [{ name: 'x', type: 'number' }],
      outputs: [{ name: 'y', type: 'number' }],
      controls: [{ name: 'factor', label: 'Factor', kind: 'number', defaultValue: 1 }],
    }), 'plugin-b')

    const types = reg.listTypes()
    const a = types.find(type => type.type === 'type-a')!
    assert.equal(a.sourcePlugin, 'plugin-a')
    assert.deepEqual([a.inputs, a.outputs], [[], []])

    const b = types.find(type => type.type === 'type-b')!
    assert.equal(b.sourcePlugin, 'plugin-b')
    assert.deepEqual(b.inputs, [{ name: 'x', type: 'number' }])
    assert.deepEqual(b.outputs.map(port => port.name), ['y'])
    assert.deepEqual(b.controls.map(control => control.name), ['factor'])

    assert.throws(
      () => reg.register(executor('duplicate-port', {
        inputs: [{ name: 'x', type: 'any' }, { name: 'x', type: 'any' }],
      }), 'test-plugin'),
      /输入端口 x 重复/,
    )
  })

  it('disposer 移除它自己注册的执行器，不删除后续同类型注册', () => {
    const reg = registry()
    const first = executor('replaceable')
    const second = executor('replaceable')

    const disposeFirst = reg.register(first, 'first-plugin')
    assert.equal(reg.get('replaceable'), first)
    disposeFirst()
    assert.equal(reg.get('replaceable'), undefined)

    reg.register(second, 'second-plugin')
    disposeFirst()
    assert.equal(reg.get('replaceable'), second)
  })
})
