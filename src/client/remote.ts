/**
 * Strict Client Remote descriptors for the out-of-tree Workflow Studio bundle.
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

/** Client view of the `workflowStudio` Remote; every result is a string, JSON where noted on the Host method. */
export interface WorkflowStudioRemoteNamespace {
  snapshot(): Promise<RemoteResult<string>>
  save(source: string): Promise<RemoteResult<string>>
  update(workflowId: string, source: string): Promise<RemoteResult<string>>
  start(workflowId: string): Promise<RemoteResult<string>>
  listRuns(): Promise<RemoteResult<string>>
  getRun(runId: string): Promise<RemoteResult<string>>
  pause(runId: string): Promise<RemoteResult<string>>
  resume(runId: string): Promise<RemoteResult<string>>
  cancel(runId: string): Promise<RemoteResult<string>>
  answer(runId: string, nodeId: string, requestId: string, answer: string): Promise<RemoteResult<string>>
}

type Method = keyof WorkflowStudioRemoteNamespace

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    workflowStudio: WorkflowStudioRemoteNamespace
  }

  interface TypertRemoteMap {
    'workflowStudio/snapshot': WorkflowStudioRemoteNamespace['snapshot']
    'workflowStudio/save': WorkflowStudioRemoteNamespace['save']
    'workflowStudio/update': WorkflowStudioRemoteNamespace['update']
    'workflowStudio/start': WorkflowStudioRemoteNamespace['start']
    'workflowStudio/listRuns': WorkflowStudioRemoteNamespace['listRuns']
    'workflowStudio/getRun': WorkflowStudioRemoteNamespace['getRun']
    'workflowStudio/pause': WorkflowStudioRemoteNamespace['pause']
    'workflowStudio/resume': WorkflowStudioRemoteNamespace['resume']
    'workflowStudio/cancel': WorkflowStudioRemoteNamespace['cancel']
    'workflowStudio/answer': WorkflowStudioRemoteNamespace['answer']
  }
}

const stringCodec = {
  mode: 'strict',
  typeSymbol: 'typescript#string',
  schema: z.string(),
  create: () => z.string(),
} as const

/** Describe one direct method whose parameters and result are all strings. */
function descriptor(method: Method, parameters: readonly string[]): TypertRemoteContribution['descriptors'][number] {
  return {
    id: `dsh-workflow-studio#workflowStudio/${method}`,
    service: 'workflowStudioController',
    namespace: 'workflowStudio',
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map(name => ({ name, wire: name, source: 'json', codec: stringCodec })),
    result: stringCodec,
  }
}

const contribution: TypertRemoteContribution = {
  package: 'dsh-workflow-studio',
  descriptors: [
    descriptor('snapshot', []),
    descriptor('save', ['source']),
    descriptor('update', ['workflowId', 'source']),
    descriptor('start', ['workflowId']),
    descriptor('listRuns', []),
    descriptor('getRun', ['runId']),
    descriptor('pause', ['runId']),
    descriptor('resume', ['runId']),
    descriptor('cancel', ['runId']),
    descriptor('answer', ['runId', 'nodeId', 'requestId', 'answer']),
  ],
}

export default contribution
