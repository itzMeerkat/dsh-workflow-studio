/** Main workflow authoring panel: workflow selection, save and run, and the canvas, execution, and runs views. */

import {
  Button,
  IconBranchOutline16,
  IconDownloadOutline16,
  IconFolderOpenOutline16,
  IconListPenOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import type { DagWorkflowDefinition, NodeTypeSummary, WorkflowStudioSnapshot } from '../shared/types.ts'
import { ExecutionOrderView } from './ExecutionOrderView.tsx'
import type { NS } from './locale.ts'
import { NodeLibraryMenu, WorkflowPicker } from './Menus.tsx'
import {
  appendEditorNode,
  formatEditorDefinition,
  nextWorkflowName,
  parseEditorDefinition,
  parseSnapshot,
  type WorkflowRow,
} from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { RunsView } from './RunsView.tsx'
import { isActiveRun, runRecordsByNode } from './runs-model.ts'
import { downloadWorkflow, importedWorkflowName, parseImportedWorkflow } from './transfer.ts'
import { useRuns } from './use-runs.ts'
import { WorkflowGraphEditor } from './WorkflowGraphEditor.tsx'
import css from './WorkflowStudioPanel.module.css'

type View = 'canvas' | 'execution' | 'runs'

const VIEWS = [
  { view: 'canvas', Icon: IconBranchOutline16 },
  { view: 'execution', Icon: IconListPenOutline16 },
  { view: 'runs', Icon: IconPlayOutline16 },
] as const satisfies readonly { view: View; Icon: unknown }[]

/** Props the `main` slot passes to the panel. */
export interface WorkflowStudioPanelProps extends PropsLocale<typeof NS>, PropsRenderSlots<'workflowStudio.request'> {
  remote: WorkflowStudioRemoteNamespace
}

/** Main workflow authoring surface. */
export function WorkflowStudioPanel({ t, remote, renderSlot }: WorkflowStudioPanelProps) {
  const [snapshot, setSnapshot] = useState<WorkflowStudioSnapshot>({ workflows: [], nodeTypes: [] })
  const [selectedId, setSelectedId] = useState<string>()
  const [definition, setDefinition] = useState<DagWorkflowDefinition>(() => emptyDefinition('workflow-1'))
  // Incremented when the canvas must discard its local graph and reload `definition`.
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<View>('canvas')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'running'>('loading')
  const [notice, setNotice] = useState<string>()
  const runs = useRuns(remote, setNotice)
  const importInput = useRef<HTMLInputElement>(null)

  const replaceDefinition = (next: DagWorkflowDefinition): void => {
    setDefinition(next)
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  const select = (workflow: WorkflowRow): void => {
    try {
      replaceDefinition(parseEditorDefinition(workflow.definition))
      setSelectedId(workflow.id)
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  const load = async (preferredId?: string): Promise<void> => {
    setPhase('loading')
    setNotice(undefined)
    const next = await callRemote(() => remote.snapshot(), parseSnapshot, setNotice)
    if (next !== undefined) {
      setSnapshot(next)
      const selected = next.workflows.find(row => row.id === preferredId)
        ?? next.workflows.find(row => row.id === selectedId)
        ?? next.workflows[0]
      if (selected !== undefined) select(selected)
    }
    setPhase('ready')
  }

  useEffect(() => {
    void load()
  }, [])

  /** Save the edited definition and return its workflow ID; failures show as the notice. */
  const persist = async (): Promise<string | undefined> => {
    const source = formatEditorDefinition(definition)
    const workflowId = await callRemote(
      () => selectedId === undefined ? remote.save(source) : remote.update(selectedId, source),
      id => id,
      setNotice,
    )
    if (workflowId !== undefined) setSelectedId(workflowId)
    return workflowId
  }

  const save = async (): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const workflowId = await persist()
    if (workflowId === undefined) {
      setPhase('ready')
      return
    }
    await load(workflowId)
    setNotice(t('notice.saved'))
  }

  /** Save, start a run without waiting for it, and open it in the Runs view. */
  const run = async (): Promise<void> => {
    setPhase('running')
    setNotice(undefined)
    const workflowId = await persist()
    const runId = workflowId === undefined
      ? undefined
      : await callRemote(() => remote.start(workflowId), id => id, setNotice)
    if (runId !== undefined) {
      runs.setFilter('workflow')
      setView('runs')
      runs.select(runId)
    }
    setPhase('ready')
  }

  /** Load one picked file into the editor as an unsaved workflow. */
  const importFile = async (file: File): Promise<void> => {
    try {
      const imported = parseImportedWorkflow(await file.text())
      setSelectedId(undefined)
      replaceDefinition({ ...imported, name: importedWorkflowName(imported.name, snapshot.workflows) })
      setView('canvas')
      setNotice(t('notice.imported'))
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  const showAllRuns = (): void => {
    runs.setFilter('all')
    setView('runs')
  }

  const busy = phase !== 'ready'
  const overlay = runs.record?.workflowId === selectedId ? runs.record : undefined
  const runRecords = overlay === undefined ? new Map() : runRecordsByNode(overlay)
  const runResult = overlay === undefined ? undefined : JSON.stringify(overlay.nodes, null, 2)
  const activeRuns = runs.runs.filter(row => isActiveRun(row)).length
  const waitingRequests = runs.runs.reduce((count, row) => count + row.pendingRequests, 0)
  return (
    <main className={css.page} aria-label={t('title')}>
      <header className={css.header}>
        <div className={css.editorTools}>
          <input
            className={css.workflowName}
            aria-label={t('workflows.name')}
            value={definition.name}
            readOnly={view !== 'canvas'}
            onChange={(event) => {
              setDefinition({ ...definition, name: event.currentTarget.value })
            }}
          />
          <WorkflowPicker
            disabled={busy}
            workflows={snapshot.workflows}
            selectedId={selectedId}
            t={t}
            onCreate={() => {
              setSelectedId(undefined)
              replaceDefinition(emptyDefinition(nextWorkflowName(snapshot.workflows)))
            }}
            onSelect={select}
          />
          <div className={css.viewTabs} role="tablist" aria-label={t('view.label')}>
            {VIEWS.map(({ view: tab, Icon }) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view === tab}
                onClick={() => { setView(tab) }}
              >
                <Icon size={14} />
                {t(`view.${tab}`)}
              </button>
            ))}
          </div>
          {view === 'canvas' && (
            <NodeLibraryMenu
              disabled={busy}
              nodeTypes={snapshot.nodeTypes}
              t={t}
              onSelect={(nodeType: NodeTypeSummary) => { replaceDefinition(appendEditorNode(definition, nodeType)) }}
            />
          )}
        </div>
        <div className={css.actions}>
          {phase === 'loading' && <span className={css.headerStatus}>{t('status.loading')}</span>}
          {activeRuns > 0 && (
            <button type="button" className={css.runBadge} onClick={showAllRuns}>
              {activeRuns} {t('runs.activeCount')}
            </button>
          )}
          {waitingRequests > 0 && (
            <button type="button" className={css.runBadge} data-status="waiting" onClick={showAllRuns}>
              {waitingRequests} {t('runs.waitingCount')}
            </button>
          )}
          <Button
            size="sm"
            variant="outline"
            icon={<IconRefreshOutline16 size={14} />}
            disabled={busy}
            onClick={() => { void load() }}
          >
            {t('action.refresh')}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              // Clear the picker so choosing the same file again still fires a change.
              event.currentTarget.value = ''
              if (file !== undefined) void importFile(file)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            icon={<IconFolderOpenOutline16 size={14} />}
            disabled={busy}
            onClick={() => { importInput.current?.click() }}
          >
            {t('action.import')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<IconDownloadOutline16 size={14} />}
            disabled={busy}
            onClick={() => { downloadWorkflow(definition) }}
          >
            {t('action.export')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void save() }}>
            {phase === 'saving' ? t('action.saving') : t('action.save')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlayOutline16 size={14} />}
            disabled={busy}
            onClick={() => { void run() }}
          >
            {phase === 'running' ? t('action.running') : t('action.run')}
          </Button>
        </div>
      </header>

      <div className={css.workspace}>
        <section className={css.editor}>
          {view === 'runs' && (
            <RunsView
              t={t}
              runs={runs.runs}
              filter={runs.filter}
              currentWorkflowId={selectedId}
              selectedRunId={runs.selectedRunId}
              record={runs.record}
              nodeTypes={snapshot.nodeTypes}
              busy={runs.busy}
              onFilter={runs.setFilter}
              onSelect={runs.select}
              onAction={runs.act}
              onSignal={runs.signal}
              renderSlot={renderSlot}
            />
          )}
          {view === 'canvas' && (
            <WorkflowGraphEditor
              definition={definition}
              revision={revision}
              nodeTypes={snapshot.nodeTypes}
              runRecords={runRecords}
              t={t}
              onChange={setDefinition}
              onError={setNotice}
              {...(runResult === undefined ? {} : { runResult })}
            />
          )}
          {view === 'execution' && (
            <ExecutionOrderView
              definition={definition}
              nodeTypes={snapshot.nodeTypes}
              runRecords={runRecords}
              t={t}
            />
          )}
          {notice !== undefined && <p className={css.notice} role="alert">{notice}</p>}
        </section>
      </div>
    </main>
  )
}

/** A workflow with no nodes; Studio registers no nodes, so the template names none. */
function emptyDefinition(name: string): DagWorkflowDefinition {
  return { name, nodes: [], edges: [] }
}
