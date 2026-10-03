/**
 * 保存、改名或删除工作流，并让它和嵌入它的工作流写进原子目录的文件随之一致。
 * @module dsh-workflow-studio
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { workflowCallees } from './atom-folder.ts'
import { describeRenderFault } from './diagnostic-message.ts'
import type { DagEngine } from './engine.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import { analyzeWorkflow, indexNodeTypes } from './shared/analysis.ts'
import { buildWorkflowIr } from './shared/ir.ts'
import { languageOf } from './shared/language.ts'
import { RenderError, renderWorkflow } from './shared/source.ts'
import { SUBWORKFLOW_TYPE, subworkflowOf } from './shared/subworkflow.ts'
import type { DagWorkflowDefinition, SavedWorkflow, WorkflowId } from './shared/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowFiles: WorkflowFiles
  }
}

/**
 * 一个工作流生成的文件在原子目录中的路径。
 * @param definition - 工作流定义。
 * @param id - 工作流 ID，也是文件名的主体。
 * @returns 路径；工作流没有原子目录时为 undefined。
 */
export function workflowFilePath(definition: DagWorkflowDefinition, id: WorkflowId): string | undefined {
  const syntax = languageOf(definition).functions?.atoms
  if (definition.atomFolder === undefined || syntax === undefined) return undefined
  return join(definition.atomFolder, `${id}${syntax.outputSuffix}`)
}

/**
 * 写原子目录文件的保存、更新与删除。
 *
 * 每次操作先改引擎中的定义，再写或删文件，并重写直接嵌入它的工作流的文件，因为它们按它的签名调用它。
 * 操作逐个执行：两次保存若交错，后一次可能读到前一次写了一半的目录，或删掉前一次刚写的文件。
 * 源码写不出时工作流照样保存，它的文件被删除，免得包里留下与定义不一致的函数。
 */
export class WorkflowFiles extends Service {
  static inject = ['dagEngine', 'workflowNodeRegistry']

  private readonly engine: DagEngine
  private readonly registry: WorkflowNodeRegistry
  private tail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'workflowFiles')
    this.engine = ctx.dagEngine
    this.registry = ctx.workflowNodeRegistry
  }

  /**
   * 创建一个工作流，或替换同名的工作流。
   * @param definition - 完整定义。
   * @returns 工作流 ID，以及它和嵌入它的工作流写不出源码时的原因。
   * @throws 引擎拒绝保存时；此时文件不动。
   */
  save(definition: DagWorkflowDefinition): Promise<SavedWorkflow> {
    return this.serialize(async () => {
      const replaces = this.engine.findByName(definition.name)?.id
      return this.writeAfter(definition, () => this.engine.save(definition), replaces)
    })
  }

  /**
   * 替换一个已有工作流；改名时它的文件随新 ID 改名。
   * @param id - 已有工作流的 ID。
   * @param definition - 完整的新定义。
   * @returns 同 {@link save}；改名后为新 ID。
   * @throws 引擎拒绝更新时；此时文件不动。
   */
  update(id: WorkflowId, definition: DagWorkflowDefinition): Promise<SavedWorkflow> {
    return this.serialize(async () => this.writeAfter(definition, () => this.engine.update(id, definition), id))
  }

  /**
   * 删除一个工作流和它写进原子目录的文件；它保留的运行记录不动。
   * @param id - 工作流 ID。
   * @throws 引擎拒绝删除时；此时文件不动。
   */
  delete(id: WorkflowId): Promise<void> {
    return this.serialize(async () => {
      const definition = this.engine.get(id)
      await this.engine.delete(id)
      const path = definition === undefined ? undefined : workflowFilePath(definition, id)
      if (path !== undefined) await rm(path, { force: true })
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  /**
   * 执行引擎的保存或更新，随后写出文件。被替换的工作流原先的文件若不再是它的文件（改了名或换了原子目录），也被删除。
   * @param replaces - 被替换的工作流 ID；新建时省略。
   */
  private async writeAfter(
    definition: DagWorkflowDefinition,
    save: () => Promise<WorkflowId>,
    replaces: WorkflowId | undefined,
  ): Promise<SavedWorkflow> {
    const previous = replaces === undefined ? undefined : this.engine.get(replaces)
    const before = previous === undefined || replaces === undefined ? undefined : workflowFilePath(previous, replaces)
    const workflowId = await save()
    if (before !== undefined && before !== workflowFilePath(definition, workflowId)) await rm(before, { force: true })
    const sourceError = await this.writeFile(definition, workflowId)
    const embedderErrors: { name: string; error: string }[] = []
    for (const { id } of this.engine.list()) {
      // list() 与 get() 同步读取同一张表，列出的 ID 一定存在。
      const embedder = this.engine.get(id)!
      if (!embedder.nodes.some(node => node.type === SUBWORKFLOW_TYPE && subworkflowOf(node.config) === workflowId)) continue
      const error = await this.writeFile(embedder, id)
      if (error !== undefined) embedderErrors.push({ name: embedder.name, error })
    }
    return {
      workflowId,
      ...(sourceError === undefined ? {} : { sourceError }),
      ...(embedderErrors.length === 0 ? {} : { embedderErrors }),
    }
  }

  /**
   * 写出一个已保存的工作流的文件 `<ID><后缀>`；它没有原子目录时什么也不写。
   * @returns 源码写不出的原因；写出或不必写时为 undefined。
   */
  private async writeFile(definition: DagWorkflowDefinition, id: WorkflowId): Promise<string | undefined> {
    const path = workflowFilePath(definition, id)
    if (path === undefined) return undefined
    const written = await this.source(definition)
    if ('error' in written) {
      await rm(path, { force: true })
      return written.error
    }
    await writeFile(path, written.source)
    return undefined
  }

  /** 工作流写进原子目录的源码，或写不出时说明要修改的节点。 */
  private async source(definition: DagWorkflowDefinition): Promise<{ readonly source: string } | { readonly error: string }> {
    const catalog = indexNodeTypes(this.registry.listTypes())
    const callees = await workflowCallees(definition, this.engine)
    try {
      return { source: renderWorkflow(buildWorkflowIr(definition, catalog, analyzeWorkflow(definition, catalog)), languageOf(definition), callees) }
    } catch (error: unknown) {
      if (error instanceof RenderError) return { error: describeRenderFault(error.fault) }
      throw error
    }
  }
}

export default WorkflowFiles
