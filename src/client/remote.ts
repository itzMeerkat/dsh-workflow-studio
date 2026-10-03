/**
 * Strict Client Remote descriptors for the out-of-tree Workflow Studio bundle.
 *
 * Every parameter and result travels as a typed JSON value; the codecs reuse the schemas the Host validates with,
 * so the browser receives parsed, checked values and never decodes a JSON string itself.
 */

import type {
  RemoteResult, RemoteStreamHandle, TypertCodec, TypertRemoteContribution, TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { messageOf } from '../shared/errors.ts'
import type { AtomFile } from '../shared/language.ts'
import type {
  DagWorkflowDefinition, FolderListing, JsonObject, JsonValue, RunId, SavedWorkflow, WorkflowRunRecord,
  WorkflowRunSummary, WorkflowStudioSnapshot,
} from '../shared/types.ts'
import {
  atomFilesSchema, folderListingSchema, savedWorkflowSchema, workflowDefinitionSchema, workflowRunRecordSchema,
  workflowRunSummarySchema, workflowStudioSnapshotSchema,
} from '../shared/workflow-schema.ts'

/** Client view of the `workflowStudio` Remote. */
export interface WorkflowStudioRemoteNamespace {
  snapshot(): Promise<RemoteResult<WorkflowStudioSnapshot>>
  save(definition: DagWorkflowDefinition): Promise<RemoteResult<SavedWorkflow>>
  update(workflowId: string, definition: DagWorkflowDefinition): Promise<RemoteResult<SavedWorkflow>>
  delete(workflowId: string): Promise<RemoteResult<null>>
  start(workflowId: string, inputs: JsonObject): Promise<RemoteResult<RunId>>
  /** Every retained run, newest first, and again each time a run changes. */
  watchRuns(signal?: AbortSignal): RemoteStreamHandle<readonly WorkflowRunSummary[], never>
  getRun(runId: string): Promise<RemoteResult<WorkflowRunRecord>>
  pause(runId: string): Promise<RemoteResult<WorkflowRunRecord>>
  resume(runId: string): Promise<RemoteResult<WorkflowRunRecord>>
  cancel(runId: string): Promise<RemoteResult<WorkflowRunRecord>>
  signal(runId: string, nodeId: string, requestId: string, result: JsonValue): Promise<RemoteResult<WorkflowRunRecord>>
  atomFiles(folder: string, language: string): Promise<RemoteResult<AtomFile[]>>
  folders(path: string): Promise<RemoteResult<FolderListing>>
}

type Method = keyof WorkflowStudioRemoteNamespace

/**
 * Await one Remote call.
 * @param call - The Remote call.
 * @param onError - Receives the message of a thrown error or an error result.
 * @returns The value, or undefined after a failure.
 */
export async function callRemote<T>(
  call: () => Promise<RemoteResult<T>>,
  onError: (message: string) => void,
): Promise<T | undefined> {
  try {
    const response = await call()
    if (response.ok) return response.value
    onError(response.error.message)
  } catch (error: unknown) {
    onError(messageOf(error))
  }
  return undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    workflowStudio: WorkflowStudioRemoteNamespace
  }

  interface TypertRemoteMap {
    'workflowStudio/snapshot': WorkflowStudioRemoteNamespace['snapshot']
    'workflowStudio/save': WorkflowStudioRemoteNamespace['save']
    'workflowStudio/update': WorkflowStudioRemoteNamespace['update']
    'workflowStudio/delete': WorkflowStudioRemoteNamespace['delete']
    'workflowStudio/start': WorkflowStudioRemoteNamespace['start']
    'workflowStudio/watchRuns': WorkflowStudioRemoteNamespace['watchRuns']
    'workflowStudio/getRun': WorkflowStudioRemoteNamespace['getRun']
    'workflowStudio/pause': WorkflowStudioRemoteNamespace['pause']
    'workflowStudio/resume': WorkflowStudioRemoteNamespace['resume']
    'workflowStudio/cancel': WorkflowStudioRemoteNamespace['cancel']
    'workflowStudio/signal': WorkflowStudioRemoteNamespace['signal']
    'workflowStudio/atomFiles': WorkflowStudioRemoteNamespace['atomFiles']
    'workflowStudio/folders': WorkflowStudioRemoteNamespace['folders']
  }
}

/** A strict codec validating with one schema, named after the type it carries. */
function codec(type: string, schema: TypertSchema): TypertCodec {
  return { mode: 'strict', typeSymbol: `dsh-workflow-studio#${type}`, create: () => schema }
}

const STRING = codec('string', z.string())
const JSON_VALUE = codec('JsonValue', z.json())
const JSON_OBJECT = codec('JsonObject', z.record(z.string(), z.json()))
const DEFINITION = codec('DagWorkflowDefinition', workflowDefinitionSchema)
const RUN_RECORD = codec('WorkflowRunRecord', workflowRunRecordSchema)
const SAVED = codec('SavedWorkflow', savedWorkflowSchema)

/** Describe one direct method by its parameters, in order, and its result. */
function descriptor(
  method: Method,
  parameters: readonly (readonly [string, TypertCodec])[],
  result: TypertCodec,
): TypertRemoteContribution['descriptors'][number] {
  return {
    id: `dsh-workflow-studio#workflowStudio/${method}`,
    service: 'workflowStudioController',
    namespace: 'workflowStudio',
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(([name, parameterCodec]) => ({ name, wire: name, source: 'json', codec: parameterCodec })),
    result,
  }
}

const contribution: TypertRemoteContribution = {
  package: 'dsh-workflow-studio',
  descriptors: [
    descriptor('snapshot', [], codec('WorkflowStudioSnapshot', workflowStudioSnapshotSchema)),
    descriptor('save', [['definition', DEFINITION]], SAVED),
    descriptor('update', [['workflowId', STRING], ['definition', DEFINITION]], SAVED),
    descriptor('delete', [['workflowId', STRING]], codec('null', z.null())),
    descriptor('start', [['workflowId', STRING], ['inputs', JSON_OBJECT]], STRING),
    {
      ...descriptor('watchRuns', [], codec('WorkflowRunSummary[]', z.array(workflowRunSummarySchema))),
      mode: 'stream',
      cancellation: { parameter: 'signal' },
    },
    descriptor('getRun', [['runId', STRING]], RUN_RECORD),
    descriptor('pause', [['runId', STRING]], RUN_RECORD),
    descriptor('resume', [['runId', STRING]], RUN_RECORD),
    descriptor('cancel', [['runId', STRING]], RUN_RECORD),
    descriptor('signal', [['runId', STRING], ['nodeId', STRING], ['requestId', STRING], ['result', JSON_VALUE]], RUN_RECORD),
    descriptor('atomFiles', [['folder', STRING], ['language', STRING]], codec('AtomFile[]', atomFilesSchema)),
    descriptor('folders', [['path', STRING]], codec('FolderListing', folderListingSchema)),
  ],
}

export default contribution
