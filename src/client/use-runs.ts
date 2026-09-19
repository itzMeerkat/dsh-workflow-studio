/** Run list, selected run, and run controls of the Workflow Studio panel. */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useEffect, useRef, useState } from 'react'
import type { JsonValue, WorkflowRunRecord, WorkflowRunSummary } from '../shared/types.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import type { RunAction, RunsFilter } from './RunsView.tsx'
import { parseRunRecord, parseRunSummaries } from './runs-model.ts'

/** How often the panel refreshes run statuses while it is mounted. */
const RUNS_REFRESH_MS = 2000

/**
 * Poll the run list and the selected run while mounted.
 * @param remote - The `workflowStudio` Remote.
 * @param setNotice - Shows a failure message; undefined clears it.
 * @returns Run state and the callbacks that change it.
 */
export function useRuns(remote: WorkflowStudioRemoteNamespace, setNotice: (message: string | undefined) => void) {
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[]>([])
  const [filter, setFilter] = useState<RunsFilter>('workflow')
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [record, setRecord] = useState<WorkflowRunRecord>()
  const [busy, setBusy] = useState(false)
  // Read by in-flight refreshes so a late response for a previously selected run is dropped.
  const selectedRunRef = useRef<string | undefined>(undefined)
  selectedRunRef.current = selectedRunId

  const refresh = async (): Promise<void> => {
    const list = await callRemote(() => remote.listRuns(), parseRunSummaries, setNotice)
    if (list === undefined) return
    setRuns(list)
    const runId = selectedRunRef.current
    if (runId === undefined) return
    const detail = await callRemote(() => remote.getRun(runId), parseRunRecord, setNotice)
    if (detail !== undefined && selectedRunRef.current === runId) setRecord(detail)
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, RUNS_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [])

  const select = (runId: string): void => {
    selectedRunRef.current = runId
    setSelectedRunId(runId)
    setRecord(undefined)
    void refresh()
  }

  /** Apply a run control or answer and show the record it returns. */
  const control = async (call: () => Promise<RemoteResult<string>>): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const next = await callRemote(call, parseRunRecord, setNotice)
    if (next !== undefined) {
      setRecord(next)
      await refresh()
    }
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
      if (runId !== undefined) void control(() => remote.signal(runId, nodeId, requestId, JSON.stringify(result)))
    },
  }
}
