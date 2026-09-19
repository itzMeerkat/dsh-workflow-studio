/**
 * DAG 引擎 Service Definition。
 *
 * 定义 {@link ctx.dagEngine} 的服务契约和生命周期事件。
 * @module dsh-workflow-studio
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DagWorkflowDefinition, WorkflowId, RunId,
  WorkflowResult, WorkflowSummary,
  DagRunInfo, NodeRunInfo, WorkflowRunStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dagEngine: DagEngine
  }

  interface Events {
    /**
     * 一个工作流运行启动。
     * @mode emit
     * @param info - 运行身份与当前状态。
     */
    'dag/start'(info: DagRunInfo): void
    /**
     * 一个节点进入执行。
     * @mode emit
     * @param info - 工作流运行信息。
     * @param node - 节点运行信息。
     */
    'dag/node-start'(info: DagRunInfo, node: NodeRunInfo): void
    /**
     * 一个节点执行完毕。
     * @mode emit
     * @param info - 工作流运行信息。
     * @param node - 节点运行信息。
     */
    'dag/node-end'(info: DagRunInfo, node: NodeRunInfo): void
    /**
     * 运行暂停。
     * @mode emit
     * @param info - 已暂停的运行信息。
     */
    'dag/paused'(info: DagRunInfo): void
    /**
     * 运行恢复。
     * @mode emit
     * @param info - 已恢复的运行信息。
     */
    'dag/resumed'(info: DagRunInfo): void
    /**
     * 运行结束（无论何种原因）。
     * @mode emit
     * @param info - 已结束的运行信息。
     * @param result - 最终状态与可选错误。
     */
    'dag/end'(info: DagRunInfo, result: { status: WorkflowRunStatus; error?: string }): void
  }
}

/** 运行的持有者 handle。 */
export interface DagRun {
  readonly runId: RunId
  readonly meta: { name: string; description?: string }
  /** 永不 reject 的结果 promise。 */
  readonly result: Promise<WorkflowResult>
  pause(): void
  resume(): void
  cancel(reason?: string): void
  dispose(): Promise<void>
}

/**
 * DAG 引擎服务抽象类。
 *
 * 负责工作流定义的持久化、节点调度执行、暂停和恢复。
 */
export abstract class DagEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'dagEngine')
  }

  /**
   * 创建或按名称替换一个工作流定义。
   * @param definition - 完整定义；同名定义复用已有 ID。
   * @returns 持久化完成后的工作流 ID。
   */
  abstract save(definition: DagWorkflowDefinition): Promise<WorkflowId>

  /**
   * 按 ID 替换一个现有工作流定义。
   * @param id - 必须已存在的工作流 ID。
   * @param definition - 完整的新定义；名称不得与其他工作流重复。
   * @returns 持久化完成后的工作流 ID。
   */
  abstract update(id: WorkflowId, definition: DagWorkflowDefinition): Promise<WorkflowId>

  /** 按 ID 获取工作流定义。 */
  abstract get(id: WorkflowId): DagWorkflowDefinition | undefined

  /** 列出所有已知工作流。 */
  abstract list(): WorkflowSummary[]

  /** 按名称查找工作流。 */
  abstract findByName(name: string): WorkflowSummary | undefined

  /** 启动一个已保存的工作流，返回运行 handle。 */
  abstract start(workflowId: WorkflowId): DagRun

  /** 获取运行状态。 */
  abstract getRun(runId: RunId): WorkflowResult | undefined

  /** 安全派发 Cordis 事件。 */
  protected emitEvent(name: string, ...args: unknown[]): void {
    const callbacks = this.ctx.events.dispatch('emit', [name, ...args]) as readonly ((...p: unknown[]) => unknown)[]
    for (const cb of callbacks) {
      try {
        const ret = cb(...args)
        if (ret instanceof Promise) {
          void ret.catch((e: unknown) => {
            this.ctx.logger.warn(`dag: ${name} listener rejected: ${String(e)}`)
          })
        }
      } catch (e: unknown) {
        this.ctx.logger.warn(`dag: ${name} listener threw: ${String(e)}`)
      }
    }
  }
}

export default DagEngine
