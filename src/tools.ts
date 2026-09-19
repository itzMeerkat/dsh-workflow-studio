/**
 * 模型面工作流管理工具。
 *
 * 通过 `ctx.tools` 注册 create_workflow / run_workflow 两个工具。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DagWorkflowDefinition } from './types.ts'
import { workflowDefinitionSchema } from './workflow-schema.ts'

/**
 * Parse one untrusted JSON value into a workflow definition.
 * @param value - Decoded JSON value received from a tool or Remote caller.
 * @returns A detached definition ready for engine validation.
 */
export function parseWorkflowDefinition(value: unknown): DagWorkflowDefinition {
  return workflowDefinitionSchema.parse(value)
}

/**
 * 注册所有工作流模型工具。
 * @param ctx - Cordis context，需已加载 dagEngine 服务。
 * @returns 同时卸载两个工具的 disposer。
 */
export function registerWorkflowTools(ctx: Context): () => void {
  const engine = ctx.dagEngine
  const disposers: Array<() => void> = []

  try {
    disposers.push(ctx.tools.register(defineTool({
    name: 'create_workflow',
    description: '创建或更新一个 DAG 工作流定义。接受完整的 JSON 节点/边定义，验证后持久化。同名定义会覆盖更新。',
    parameters: {
      name: { type: 'string', required: true, description: '工作流名称' },
      description: { type: 'string', description: '工作流描述' },
      nodes: {
        type: 'array',
        required: true,
        description: '节点列表。每个节点包含 id, type, label?, config?, inputs?, outputs?',
        items: { type: 'json' },
      },
      edges: {
        type: 'array',
        required: true,
        description: '边列表。每条边包含 id, source, target, sourcePort?, targetPort?',
        items: { type: 'json' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: '工作流定义 ID' },
          name: { type: 'string', description: '工作流名称' },
          nodeCount: { type: 'number', description: '节点数量' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `工作流 "${value.name}" 已保存 (ID: ${value.workflowId}, ${value.nodeCount} 个节点)` },
      ],
    },
    async execute(args, _exec) {
      const def = parseWorkflowDefinition({
        name: args.name,
        nodes: args.nodes,
        edges: args.edges,
        ...(args.description === undefined ? {} : { description: args.description }),
      })
      const workflowId = await engine.save(def)
      return {
        workflowId,
        name: args.name,
        nodeCount: args.nodes.length,
      }
    },
    })))

    disposers.push(ctx.tools.register(defineTool({
    name: 'run_workflow',
    description: '按名称启动一个已定义的工作流执行，返回运行 ID。',
    parameters: {
      name: { type: 'string', required: true, description: '要运行的工作流名称' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '运行 ID' },
          status: { type: 'string', description: '运行状态' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `工作流运行已启动 (runId: ${value.runId}, 状态: ${value.status})` },
      ],
    },
    async execute(args, _exec) {
      const summary = engine.findByName(args.name)
      if (summary === undefined) {
        throw new Error(`工作流 "${args.name}" 未找到`)
      }
      const run = engine.start(summary.id)
      return { runId: run.runId, status: 'running' }
    },
    })))
  } catch (error: unknown) {
    for (const dispose of [...disposers].reverse()) dispose()
    throw error
  }

  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
