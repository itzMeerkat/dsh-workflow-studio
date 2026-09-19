/**
 * 工作流节点注册表 Service Definition。
 *
 * 管理所有 {@link WorkflowNodeExecutor} 的注册与查询。
 * @module dsh-workflow-studio
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  NodeControlDefinition,
  PortDefinition,
  WorkflowNodeExecutor,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowNodeRegistry: WorkflowNodeRegistry
  }
}

/** 节点类型列表查询结果摘要。 */
export interface NodeTypeSummary {
  type: string
  label: string
  description: string
  sourcePlugin: string
  requiresHumanInput?: boolean
  inputs: readonly PortDefinition[]
  outputs: readonly PortDefinition[]
  controls: readonly NodeControlDefinition[]
  variadicInputs?: WorkflowNodeExecutor['variadicInputs']
}

/**
 * 节点注册表。
 *
 * 节点以 Cordis 插件方式通过 {@link register} 注入。
 * 注册返回 disposer，支持热卸载。
 * 查询时按 type 精确匹配。
 */
export class WorkflowNodeRegistry extends Service {
  private readonly executors = new Map<string, {
    executor: WorkflowNodeExecutor
    sourcePlugin: string
  }>()

  constructor(ctx: Context) {
    super(ctx, 'workflowNodeRegistry')
  }

  /**
   * 注册一个节点执行器。
   * @param executor - 实现 {@link WorkflowNodeExecutor} 接口的对象。
   * @param sourcePlugin - 提供该节点类型的 Cordis 插件名。
   * @returns Cordis disposer，卸载时会取消注册。
   */
  register(executor: WorkflowNodeExecutor, sourcePlugin: string): () => void {
    const type = executor.type
    if (sourcePlugin.trim() === '') {
      throw new Error(`节点类型 "${type}" 的来源插件名不能为空`)
    }
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(type)) {
      throw new Error(`节点类型 "${type}" 必须为小写 kebab-case`)
    }
    if (this.executors.has(type)) {
      throw new Error(`节点类型 "${type}" 已注册`)
    }
    for (const [kind, ports] of [['输入', executor.inputs ?? []], ['输出', executor.outputs ?? []]] as const) {
      const names = new Set<string>()
      for (const port of ports) {
        if (names.has(port.name)) throw new Error(`节点类型 "${type}" 的${kind}端口 ${port.name} 重复`)
        names.add(port.name)
      }
    }
    if (executor.variadicInputs !== undefined
      && (!Number.isInteger(executor.variadicInputs.min) || executor.variadicInputs.min < 1)) {
      throw new Error(`节点类型 "${type}" 的可变输入最小数量必须为正整数`)
    }
    const registration = { executor, sourcePlugin }
    this.executors.set(type, registration)
    this.ctx.logger.info(`[workflow] 注册节点: ${type}`)

    return () => {
      if (this.executors.get(type) !== registration) return
      this.executors.delete(type)
      this.ctx.logger.info(`[workflow] 卸载节点: ${type}`)
    }
  }

  /**
   * 按类型名获取节点执行器。
   * @returns 执行器实例，或 undefined。
   */
  get(type: string): WorkflowNodeExecutor | undefined {
    return this.executors.get(type)?.executor
  }

  /**
   * 列出所有已注册的节点类型。
   */
  listTypes(): NodeTypeSummary[] {
    return [...this.executors.values()].map(({ executor: e, sourcePlugin }) => {
      const s: NodeTypeSummary = {
        type: e.type,
        label: e.label,
        description: e.description,
        sourcePlugin,
        inputs: e.inputs ?? [],
        outputs: e.outputs ?? [],
        controls: e.controls ?? [],
      }
      if (e.requiresHumanInput !== undefined) s.requiresHumanInput = e.requiresHumanInput
      if (e.variadicInputs !== undefined) s.variadicInputs = e.variadicInputs
      return s
    })
  }
}

export default WorkflowNodeRegistry
