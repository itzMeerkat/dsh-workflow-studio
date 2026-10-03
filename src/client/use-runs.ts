/** Run list, selected run, and run controls of the Workflow Studio panel. */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useEffect, useRef, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import type { JsonValue, WorkflowRunRecord, WorkflowRunSummary } from '../shared/types.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import type { RunAction, RunsFilter } from './RunsView.tsx'

/** How long the panel waits before watching the runs again after the Host stream ended or failed. */
const REWATCH_DELAY_MS = 2000

/**
 * Keep the run list and the selected run current while mounted. The Host pushes the run list whenever a run changes;
 * the selected run's record is read again when its row changes.
 * @param remote - The `workflowStudio` Remote.
 * @param setNotice - Shows a failure message; undefined clears it.
 * @returns Run state and the callbacks that change it.
 */
export function useRuns(
  remote: WorkflowStudioRemoteNamespace,
  setNotice: (message: string | undefined) => void,
) {
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[]>([])
  const [filter, setFilter] = useState<RunsFilter>('workflow')
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [record, setRecord] = useState<WorkflowRunRecord>()
  const [busy, setBusy] = useState(false)
  // Read by in-flight reads so a late response for a previously selected run is dropped.
  const selectedRunRef = useRef<string | undefined>(undefined)
  selectedRunRef.current = selectedRunId

  const readSelected = async (): Promise<void> => {
    const runId = selectedRunRef.current
    if (runId === undefined) return
    const detail = await callRemote(() => remote.getRun(runId), setNotice)
    if (detail !== undefined && selectedRunRef.current === runId) setRecord(detail)
  }

  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const watch = async (): Promise<void> => {
      const handle = remote.watchRuns(controller.signal)
      try {
        let seen: number | undefined
        for await (const list of handle) {
          setRuns(list)
          const selected = list.find(row => row.runId === selectedRunRef.current)?.updatedAt
          if (selected !== seen) {
            seen = selected
            void readSelected()
          }
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) setNotice(messageOf(error))
      } finally {
        handle.dispose()
      }
      if (!controller.signal.aborted) retry = setTimeout(() => { void watch() }, REWATCH_DELAY_MS)
    }
    void watch()
    return () => {
      controller.abort()
      clearTimeout(retry)
    }
  }, [])

  const select = (runId: string): void => {
    selectedRunRef.current = runId
    setSelectedRunId(runId)
    setRecord(undefined)
    void readSelected()
  }

  /** Apply a run control or answer and show the record it returns. */
  const control = async (call: () => Promise<RemoteResult<WorkflowRunRecord>>): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const next = await callRemote(call, setNotice)
    if (next !== undefined && selectedRunRef.current === next.runId) setRecord(next)
    setBusy(false)
  }

  return {
    runs,
    filter,
    setFilter,
    selectedRunId,
    record,
    busy,
    select,
    act: (action: RunAction): void => {
      const runId = selectedRunRef.current
      if (runId !== undefined) void control(() => remote[action](runId))
    },
    signal: (nodeId: string, requestId: string, result: JsonValue): void => {
      const runId = selectedRunRef.current
      if (runId !== undefined) void control(() => remote.signal(runId, nodeId, requestId, result))
    },
  }
}
