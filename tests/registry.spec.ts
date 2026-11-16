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
    execute: () => ({ outputs: {} }),
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
})
