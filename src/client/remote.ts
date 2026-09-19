/**
 * Strict Client Remote descriptors for the out-of-tree Workflow Studio bundle.
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

interface WorkflowStudioRemoteNamespace {
  snapshot(): Promise<RemoteResult<string>>
  save(source: string): Promise<RemoteResult<string>>
  update(workflowId: string, source: string): Promise<RemoteResult<string>>
  run(workflowId: string): Promise<RemoteResult<string>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    workflowStudio: WorkflowStudioRemoteNamespace
  }

  interface TypertRemoteMap {
    'workflowStudio/snapshot': WorkflowStudioRemoteNamespace['snapshot']
    'workflowStudio/save': WorkflowStudioRemoteNamespace['save']
    'workflowStudio/update': WorkflowStudioRemoteNamespace['update']
    'workflowStudio/run': WorkflowStudioRemoteNamespace['run']
  }
}

const stringCodec = {
  mode: 'strict',
  typeSymbol: 'typescript#string',
  schema: z.string(),
  create: () => z.string(),
} as const

const contribution: TypertRemoteContribution = {
  package: 'dsh-workflow-studio',
  descriptors: [
    {
      id: 'dsh-workflow-studio#workflowStudio/snapshot',
      service: 'workflowStudioController',
      namespace: 'workflowStudio',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: stringCodec,
    },
    {
      id: 'dsh-workflow-studio#workflowStudio/save',
      service: 'workflowStudioController',
      namespace: 'workflowStudio',
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'source',
        wire: 'source',
        source: 'json',
        codec: stringCodec,
      }],
      result: stringCodec,
    },
    {
      id: 'dsh-workflow-studio#workflowStudio/update',
      service: 'workflowStudioController',
      namespace: 'workflowStudio',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'workflowId',
        wire: 'workflowId',
        source: 'json',
        codec: stringCodec,
      }, {
        name: 'source',
        wire: 'source',
        source: 'json',
        codec: stringCodec,
      }],
      result: stringCodec,
    },
    {
      id: 'dsh-workflow-studio#workflowStudio/run',
      service: 'workflowStudioController',
      namespace: 'workflowStudio',
      method: 'run',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'workflowId',
        wire: 'workflowId',
        source: 'json',
        codec: stringCodec,
      }],
      result: stringCodec,
    },
  ],
}

export default contribution
