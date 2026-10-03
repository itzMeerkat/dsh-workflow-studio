/**
 * Host Remote used by the browser workflow editor.
 * @module dsh-workflow-studio
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { WorkflowNodeRegistry } from './registry.ts'
import type { DagEngine } from './engine.ts'
import type { WorkflowFiles } from './workflow-files.ts'
import type { AtomFile } from './shared/language.ts'
import {
  NodeId, RunId, WorkflowId, type FolderListing, type SavedWorkflow, type WorkflowRunRecord,
  type WorkflowRunSummary, type WorkflowStudioSnapshot,
} from './shared/types.ts'
import { workflowDefinitionSchema } from './shared/workflow-schema.ts'
import { messageOf } from './shared/errors.ts'
import { toJsonObject, toJsonValue } from './shared/json.ts'
import { codeLanguageOf } from './shared/language.ts'
import { listFolders, readAtomFiles } from './atom-folder.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowStudioController: WorkflowStudioController
  }
}

/** Engine events after which the run list may read differently. */
const RUN_EVENTS = [
  'dag/start', 'dag/node-start', 'dag/node-end', 'dag/paused', 'dag/resumed', 'dag/signal-requested',
  'dag/signal-received', 'dag/interrupted', 'dag/end',
] as const satisfies readonly (keyof Events)[]

const jsonObjectSchema = z.record(z.string(), z.json())

/** Host controller backing the `workflowStudio` Remote namespace. */
export class WorkflowStudioController extends TypertRemoteService {
  static inject = ['dagEngine', 'workflowNodeRegistry', 'workflowFiles']

  private readonly engine: DagEngine
  private readonly registry: WorkflowNodeRegistry
  private readonly files: WorkflowFiles

  constructor(ctx: Context) {
    super(ctx, 'workflowStudioController', { namespace: 'workflowStudio' })
    this.engine = ctx.dagEngine
    this.registry = ctx.workflowNodeRegistry
    this.files = ctx.workflowFiles
  }

  /**
   * Return what the editor works with: every saved workflow, of either kind, and every registered node type. Each
   * node type lists the workflow kinds it may appear in, and the editor offers only the ones fitting the open workflow.
   * @returns The workflows with their definitions, and the node catalog.
   */
  @Remote
  snapshot(): WorkflowStudioSnapshot {
    return {
      // list() 与 get() 同步读取同一张表，列出的 ID 一定存在。
      workflows: this.engine.list().map(summary => ({ ...summary, definition: this.engine.get(summary.id)! })),
      nodeTypes: this.registry.listTypes(),
    }
  }

  /**
   * Validate and save one browser-authored definition, replacing a saved workflow of the same name. A code workflow
   * with an atom folder is written into that folder as `<id>` plus its language's output suffix, and the files of the
   * workflows embedding it are rewritten; a workflow whose source cannot be written is still saved, and its file is
   * removed.
   * @param definition - Complete workflow definition.
   * @returns The saved workflow ID, why its source could not be written, and which embedding workflows could not be
   * rewritten and why.
   */
  @Remote
  async save(definition: unknown): Promise<SavedWorkflow> {
    return this.guard(async () => this.files.save(workflowDefinitionSchema.parse(definition)))
  }

  /**
   * Replace one existing browser-authored definition, re-keying it when its name changed, and write it into
   * its atom folder as {@link save} does.
   * @param workflowId - Existing workflow ID returned by {@link save}.
   * @param definition - Complete replacement definition.
   * @returns As {@link save} returns; renaming a workflow returns a new ID.
   */
  @Remote
  async update(workflowId: string, definition: unknown): Promise<SavedWorkflow> {
    return this.guard(async () => this.files.update(WorkflowId(workflowId), workflowDefinitionSchema.parse(definition)))
  }

  /**
   * Delete one saved workflow and the file it wrote into its atom folder; its retained runs stay.
   * @param workflowId - Workflow ID returned by {@link save}.
   * @returns null once the workflow is deleted.
   */
  @Remote
  async delete(workflowId: string): Promise<null> {
    return this.guard(async () => {
      await this.files.delete(WorkflowId(workflowId))
      return null
    })
  }

  /**
   * Read the atom files of one folder, for the browser to parse into its node library.
   * @param folder - Absolute path of the atom folder.
   * @param language - Name of a code language.
   * @returns The folder's files of that language.
   */
  @Remote
  async atomFiles(folder: string, language: string): Promise<AtomFile[]> {
    return this.guard(async () => readAtomFiles(folder, codeLanguageOf(language).functions.atoms))
  }

  /**
   * List the subfolders of one Host folder, for choosing an atom folder.
   * @param path - Absolute folder path; empty for the Host user's home folder.
   * @returns The listing.
   */
  @Remote
  async folders(path: string): Promise<FolderListing> {
    return this.guard(async () => listFolders(path))
  }

  /**
   * Start one saved workflow without waiting for it to settle.
   * @param workflowId - ID returned by {@link save}.
   * @param inputs - Values for the declared input ports; omitted ports use their default.
   * @returns The new run ID.
   */
  @Remote
  start(workflowId: string, inputs: unknown): RunId {
    return this.guardSync(() =>
      this.engine.start(WorkflowId(workflowId), toJsonObject(jsonObjectSchema.parse(inputs), 'inputs')).runId)
  }

  /**
   * Watch the retained runs: the run list now, then again whenever a run starts, moves a node, pauses, resumes,
   * waits for or receives a result, is interrupted, or ends, until the browser stops watching.
   * @param signal - Carrier cancellation.
   * @returns The run summaries, newest first, one list per change.
   */
  @Remote({ mode: 'stream' })
  watchRuns(signal: AbortSignal): AsyncIterable<WorkflowRunSummary[]> {
    return this.runLists(signal)
  }

  /**
   * Read one retained run record with its definition snapshot and node records.
   * @param runId - Run ID returned by {@link start}.
   * @returns The run record.
   */
  @Remote
  getRun(runId: string): WorkflowRunRecord {
    return this.record(runId)
  }

  /**
   * Request a pause: no new node starts, and the run pauses once the started ones settle.
   * @param runId - Run ID.
   * @returns The run record after the request.
   */
  @Remote
  pause(runId: string): WorkflowRunRecord {
    this.guardSync(() => { this.engine.pauseRun(RunId(runId)) })
    return this.record(runId)
  }

  /**
   * Resume a paused or interrupted run.
   * @param runId - Run ID.
   * @returns The run record after resuming.
   */
  @Remote
  resume(runId: string): WorkflowRunRecord {
    this.guardSync(() => { this.engine.resumeRun(RunId(runId)) })
    return this.record(runId)
  }

  /**
   * Cancel an unfinished run.
   * @param runId - Run ID.
   * @returns The run record after the request.
   */
  @Remote
  cancel(runId: string): WorkflowRunRecord {
    this.guardSync(() => { this.engine.cancelRun(RunId(runId), '用户取消') })
    return this.record(runId)
  }

  /**
   * Deliver the result a node is waiting for.
   * @param runId - Run ID.
   * @param nodeId - Node that declared the request.
   * @param requestId - Request ID from the node record's `requests`.
   * @param result - The result; the node type decides its format.
   * @returns The run record after the result is saved.
   */
  @Remote
  async signal(runId: string, nodeId: string, requestId: string, result: unknown): Promise<WorkflowRunRecord> {
    await this.guard(async () => this.engine.signal(RunId(runId), NodeId(nodeId), requestId, toJsonValue(result, 'result')))
    return this.record(runId)
  }

  /**
   * The run list once, then once per batch of engine events, until `signal` aborts. Events arriving while the browser
   * reads one list are folded into the next, so a busy run cannot queue up stale lists.
   */
  private async *runLists(signal: AbortSignal): AsyncGenerator<WorkflowRunSummary[]> {
    let changed = true
    let wake: (() => void) | undefined
    const notify = (): void => {
      changed = true
      wake?.()
    }
    const disposers = RUN_EVENTS.map(name => this.ctx.on(name, notify))
    signal.addEventListener('abort', notify)
    try {
      while (!signal.aborted) {
        if (changed) {
          changed = false
          yield this.engine.listRuns()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', notify)
      for (const dispose of disposers) dispose()
    }
  }

  private record(runId: string): WorkflowRunRecord {
    const record = this.engine.getRun(RunId(runId))
    if (record === undefined) throw new RemoteError('gateway/bad-request', `运行 ${runId} 不存在`, {})
    return record
  }

  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }

  private guardSync<T>(action: () => T): T {
    try {
      return action()
    } catch (error: unknown) {
      throw new RemoteError('gateway/bad-request', messageOf(error), {})
    }
  }
}

export default WorkflowStudioController
