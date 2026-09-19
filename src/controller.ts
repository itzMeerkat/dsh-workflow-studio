/**
 * Host Remote used by the browser workflow editor.
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowNodeRegistry } from './registry.ts'
import type { DagEngine } from './engine.ts'
import { WorkflowId } from './types.ts'
import { parseWorkflowDefinition } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowStudioController: WorkflowStudioController
  }
}

/** Browser-safe catalog entry for one registered node type. */
export interface WorkflowNodeCatalogEntry {
  readonly type: string
  readonly label: string
  readonly description: string
  readonly sourcePlugin: string
  readonly inputs: readonly import('./types.ts').PortDefinition[]
  readonly outputs: readonly import('./types.ts').PortDefinition[]
  readonly controls: readonly import('./types.ts').NodeControlDefinition[]
  readonly variadicInputs?: import('./types.ts').WorkflowNodeExecutor['variadicInputs']
}

/** Browser editor bootstrap payload encoded as JSON. */
export interface WorkflowStudioSnapshot {
  readonly workflows: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly definition: string
  }>
  readonly nodeTypes: readonly WorkflowNodeCatalogEntry[]
}

/** Host controller backing the `workflowStudio` Remote namespace. */
export class WorkflowStudioController extends TypertRemoteService {
  static inject = ['dagEngine', 'workflowNodeRegistry']

  private readonly engine: DagEngine
  private readonly registry: WorkflowNodeRegistry

  constructor(ctx: Context) {
    super(ctx, 'workflowStudioController', { namespace: 'workflowStudio' })
    this.engine = ctx.dagEngine
    this.registry = ctx.workflowNodeRegistry
  }

  /** Return all persisted definitions and the currently registered node types. */
  @Remote
  snapshot(): string {
    const payload: WorkflowStudioSnapshot = {
      workflows: this.engine.list().map((summary) => {
        const definition = this.engine.get(summary.id)
        if (definition === undefined) {
          throw new Error(`工作流 ${summary.id} 在列表读取期间消失`)
        }
        return {
          id: summary.id,
          name: summary.name,
          ...(summary.description === undefined ? {} : { description: summary.description }),
          definition: JSON.stringify(definition, null, 2),
        }
      }),
      nodeTypes: this.registry.listTypes().map(node => ({
        type: node.type,
        label: node.label,
        description: node.description,
        sourcePlugin: node.sourcePlugin,
        inputs: node.inputs ?? [],
        outputs: node.outputs ?? [],
        controls: node.controls ?? [],
        ...(node.variadicInputs === undefined ? {} : { variadicInputs: node.variadicInputs }),
      })),
    }
    return JSON.stringify(payload)
  }

  /**
   * Parse, validate, and save one browser-authored definition.
   * @param source - Complete workflow definition encoded as JSON.
   * @returns The saved workflow ID.
   */
  @Remote
  async save(source: string): Promise<string> {
    try {
      const definition = parseWorkflowDefinition(JSON.parse(source) as unknown)
      return await this.engine.save(definition)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Replace one existing browser-authored definition while preserving its ID.
   * @param workflowId - Existing workflow ID returned by {@link save}.
   * @param source - Complete replacement definition encoded as JSON.
   * @returns The updated workflow ID.
   */
  @Remote
  async update(workflowId: string, source: string): Promise<string> {
    try {
      const definition = parseWorkflowDefinition(JSON.parse(source) as unknown)
      return await this.engine.update(WorkflowId(workflowId), definition)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Run one saved workflow to settlement.
   * @param workflowId - ID returned by {@link save}.
   * @returns The final run result encoded as JSON.
   */
  @Remote
  async run(workflowId: string): Promise<string> {
    try {
      return JSON.stringify(await this.engine.start(WorkflowId(workflowId)).result)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default WorkflowStudioController
