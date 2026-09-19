/**
 * dsh-workflow-studio/demo 插件入口：注册演示节点。
 *
 * 与 Workflow Studio 核心插件分开挂载；在 profile 中禁用本行即可移除演示节点。
 * @module dsh-workflow-studio/demo
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../registry.ts'
import { createDemoNodes } from './nodes.ts'

/** Cordis 插件名，同时作为演示节点的来源插件名。 */
export const name = 'dsh-workflow-studio/demo'

/** 注册演示节点所需的服务。 */
export const inject = ['workflowNodeRegistry']

/**
 * 注册全部演示节点；任一注册失败时回滚已注册的节点。
 * @param ctx - 带有 workflowNodeRegistry 的 Cordis context。
 * @returns 移除全部演示节点的 disposer。
 */
export function registerDemoNodes(ctx: Context): () => void {
  const reg = ctx.workflowNodeRegistry
  const nodes = createDemoNodes()
  for (const node of nodes) {
    if (reg.get(node.type) !== undefined) {
      throw new Error(`节点类型 "${node.type}" 已注册`)
    }
  }
  const disposers: Array<() => void> = []
  try {
    for (const node of nodes) disposers.push(reg.register(node, name))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}

/**
 * 插件 apply。
 * @param ctx - Cordis context。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerDemoNodes(ctx), 'workflow-studio-demo:nodes')
}

export { ArithmeticNode, CoalesceNode, IfNode, InputNode, OutputNode, createDemoNodes } from './nodes.ts'
