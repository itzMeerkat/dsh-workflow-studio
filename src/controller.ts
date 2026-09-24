/**
 * Host Remote used by the browser workflow editor.
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkflowNodeRegistry } from './registry.ts'
import type { DagEngine } from './engine.ts'
import { NodeId, RunId, WorkflowId, type WorkflowStudioSnapshot } from './shared/types.ts'
import { workflowDefinitionSchema, workflowKindSchema } from './shared/workflow-schema.ts'
import { messageOf } from './shared/errors.ts'
import { parseJsonObject } from './shared/json.ts'
import { languageOf } from './shared/language.ts'
import { listFolders, readAtomFiles, saveWithFile } from './atom-folder.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowStudioController: WorkflowStudioController
  }
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

  /**
   * Return what the editor of one workflow kind works with: the saved workflows of that kind and the node
   * types usable in it. The two kinds share no workflow, so neither editor sees the other's.
   * @param kind - `run` or `code`.
   * @returns The snapshot encoded as JSON.
   */
  @Remote
  snapshot(kind: string): string {
    try {
      const own = workflowKindSchema.parse(kind)
      const payload: WorkflowStudioSnapshot = {
        // list() 与 get() 同步读取同一张表，列出的 ID 一定存在。
        workflows: this.engine.list().filter(summary => summary.kind === own).map(summary => ({
          ...summary,
          definition: JSON.stringify(this.engine.get(summary.id)!, null, 2),
        })),
        nodeTypes: this.registry.listTypes().filter(type => type.kinds.includes(own)),
      }
      return JSON.stringify(payload)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Parse, validate, and save one browser-authored definition. A code workflow with an atom folder is
   * written into that folder as `<id>` plus its language's output suffix; a workflow that cannot be written is not saved.
   * @param source - Complete workflow definition encoded as JSON.
   * @returns The saved workflow ID.
   */
  @Remote
  async save(source: string): Promise<string> {
    try {
      const definition = workflowDefinitionSchema.parse(JSON.parse(source) as unknown)
      return await saveWithFile(definition, { registry: this.registry, engine: this.engine }, () => this.engine.save(definition))
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Replace one existing browser-authored definition, re-keying it when its name changed, and write it into
   * its atom folder as {@link save} does.
   * @param workflowId - Existing workflow ID returned by {@link save}.
   * @param source - Complete replacement definition encoded as JSON.
   * @returns The workflow ID after the save; renaming a workflow returns a new ID.
   */
  @Remote
  async update(workflowId: string, source: string): Promise<string> {
    try {
      const definition = workflowDefinitionSchema.parse(JSON.parse(source) as unknown)
      const id = WorkflowId(workflowId)
      return await saveWithFile(definition, { registry: this.registry, engine: this.engine }, () => this.engine.update(id, definition), id)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Read the atom files of one folder, for the browser to parse into its node library.
   * @param folder - Absolute path of the atom folder.
   * @param language - Name of a code language that reads atoms.
   * @returns The folder's files of that language, as a JSON array of `{ file, text }`.
   */
  @Remote
  async atomFiles(folder: string, language: string): Promise<string> {
    try {
      const syntax = languageOf({ kind: 'code', language }).functions?.atoms
      if (syntax === undefined) throw new Error(`语言 ${language} 不能读原子目录`)
      return JSON.stringify(await readAtomFiles(folder, syntax))
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * List the subfolders of one Host folder, for choosing an atom folder.
   * @param path - Absolute folder path; empty for the Host user's home folder.
   * @returns The listing encoded as JSON.
   */
  @Remote
  async folders(path: string): Promise<string> {
    try {
      return JSON.stringify(await listFolders(path))
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * Start one saved workflow without waiting for it to settle.
   * @param workflowId - ID returned by {@link save}.
   * @param inputs - Values for the declared input ports, encoded as a JSON object; omitted ports use their default.
   * @returns The new run ID.
   */
  @Remote
  start(workflowId: string, inputs?: string): string {
    try {
      const values = inputs === undefined ? {} : parseJsonObject(inputs, '工作流输入')
      return this.engine.start(WorkflowId(workflowId), values).runId
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  /**
   * List retained runs, newest first.
   * @returns The run summaries encoded as JSON.
   */
  @Remote
  listRuns(): string {
    return JSON.stringify(this.engine.listRuns())
  }

  /**
   * Read one retained run record with its definition snapshot and node records.
   * @param runId - Run ID returned by {@link start}.
   * @returns The run record encoded as JSON.
   */
  @Remote
  getRun(runId: string): string {
    return this.record(runId)
  }

  /**
   * Request a pause after the current level of a running run.
   * @param runId - Run ID.
   * @returns The run record after the request, encoded as JSON.
   */
  @Remote
  pause(runId: string): string {
    this.control(() => { this.engine.pauseRun(RunId(runId)) })
    return this.record(runId)
  }

  /**
   * Resume a paused or interrupted run.
   * @param runId - Run ID.
   * @returns The run record after resuming, encoded as JSON.
   */
  @Remote
  resume(runId: string): string {
    this.control(() => { this.engine.resumeRun(RunId(runId)) })
    return this.record(runId)
  }

  /**
   * Cancel an unfinished run.
   * @param runId - Run ID.
   * @returns The run record after the request, encoded as JSON.
   */
  @Remote
  cancel(runId: string): string {
    this.control(() => { this.engine.cancelRun(RunId(runId), '用户取消') })
    return this.record(runId)
  }

  /**
   * Deliver the result a node is waiting for.
   * @param runId - Run ID.
   * @param nodeId - Node that declared the request.
   * @param requestId - Request ID from the node record's `requests`.
   * @param result - The result encoded as JSON; the node type decides its format.
   * @returns The run record after the result is saved, encoded as JSON.
   */
  @Remote
  async signal(runId: string, nodeId: string, requestId: string, result: string): Promise<string> {
    try {
      await this.engine.signal(RunId(runId), NodeId(nodeId), requestId, JSON.parse(result) as unknown)
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
    return this.record(runId)
  }

  private record(runId: string): string {
    const record = this.engine.getRun(RunId(runId))
    if (record === undefined) throw new RemoteError('gateway/bad-request', `运行 ${runId} 不存在`, {})
    return JSON.stringify(record)
  }

  private control(action: () => void): void {
    try {
      action()
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }
}

export default WorkflowStudioController
