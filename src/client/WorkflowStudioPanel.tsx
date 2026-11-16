/** Main workflow authoring panel: workflow selection, save and run, and the canvas, execution, description, and runs views. */

import {
  Button,
  IconBranchOutlineRegular,
  IconCodeOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconListPenOutlineRegular,
  IconPlayOutlineRegular,
  IconRefreshOutlineRegular,
  IconSettingsOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { XYPosition } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EXPANSION_NODE_TYPES, SUBWORKFLOW_TYPE, embedsCycle, withSubworkflows, type WorkflowLookup,
} from '../shared/subworkflow.ts'
import { WorkflowId, type JsonObject, type NodeTypeSummary } from '../shared/types.ts'
import {
  WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, workflowInputPorts,
} from '../shared/workflow-boundary.ts'
import { analyzeEditorGraph } from './analysis-model.ts'
import { CARD_WIDTH } from './graph-model.ts'
import { DescriptionView } from './DescriptionView.tsx'
import { DiagnosticsView } from './DiagnosticsView.tsx'
import { ExecutionOrderView } from './ExecutionOrderView.tsx'
import type { NS } from './locale.ts'
import { NodeLibraryMenu, WorkflowPicker } from './Menus.tsx'
import {
  appendEditorNode,
  appendSubworkflowNode,
  isTextEntry,
  type Clip,
  openFault,
  type EmbedChoice,
  type PickerRow,
} from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { RunDialog } from './RunDialog.tsx'
import { RunsView, type RequestRenderer } from './RunsView.tsx'
import { isActiveRun, runRecordsByNode } from './runs-model.ts'
import { downloadWorkflow } from './transfer.ts'
import { useRuns } from './use-runs.ts'
import { useWorkflowEditor } from './use-workflow-editor.ts'
import { WorkflowGraphEditor } from './WorkflowGraphEditor.tsx'
import { WorkflowSettings } from './WorkflowSettings.tsx'
import css from './WorkflowStudioPanel.module.css'

type View = 'canvas' | 'execution' | 'description' | 'runs'

const VIEWS = [
  { view: 'canvas', Icon: IconBranchOutlineRegular },
  { view: 'execution', Icon: IconListPenOutlineRegular },
  { view: 'description', Icon: IconCodeOutlineRegular },
  { view: 'runs', Icon: IconPlayOutlineRegular },
] as const satisfies readonly { view: View; Icon: unknown }[]

/** Props the `main` slot passes to the panel. */
export interface WorkflowStudioPanelProps extends PropsLocale<typeof NS> {
  remote: WorkflowStudioRemoteNamespace
  /** Renders a paused node's signal form in the Runs view. */
  renderRequest: RequestRenderer
}

/** Main workflow authoring surface. */
export function WorkflowStudioPanel({ t, remote, renderRequest }: WorkflowStudioPanelProps) {
  const editor = useWorkflowEditor(remote, t)
  const { snapshot, selectedId, definition, revision, phase, notice, setNotice, change } = editor
  const [view, setView] = useState<View>('canvas')
  const runs = useRuns(remote, editor.fail, () => { setNotice(undefined) })
  // Set while the run dialog is collecting values for the workflow's declared inputs.
  const [runPrompt, setRunPrompt] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const importInput = useRef<HTMLInputElement>(null)
  const viewCenter = useRef<() => XYPosition>()
  // Nodes copied on the canvas; kept while the panel is open, so they can be pasted into another workflow.
  const clipboard = useRef<Clip>()

  // The saved workflows, which subworkflow nodes link to by ID.
  const saved = useMemo(
    () => new Map(snapshot.workflows.map(row => [row.id, row.definition])),
    [snapshot.workflows],
  )
  const lookup = useMemo<WorkflowLookup>(() => id => saved.get(id), [saved])

  // Subworkflow nodes take their ports from the workflows they embed, so a workflow saved again, or a workflow
  // opened on them, may move those ports.
  useEffect(() => {
    const linked = withSubworkflows(definition, lookup)
    if (linked !== definition) editor.sync(linked)
  }, [lookup, revision])

  /** Save, start a run without waiting for it, and open it in the Runs view. */
  const startRun = async (inputs: JsonObject): Promise<void> => {
    setRunPrompt(false)
    editor.setPhase('running')
    setNotice(undefined)
    const result = await editor.persist()
    const runId = result === undefined
      ? undefined
      : await callRemote(() => remote.start(result.workflowId, inputs), editor.fail)
    if (runId !== undefined) {
      runs.setFilter('workflow')
      setView('runs')
      runs.select(runId)
    }
    editor.setPhase('ready')
  }

  /** A workflow that declares inputs asks for their values first; one that declares none just runs. */
  const run = (): void => {
    if (workflowInputPorts(definition).length > 0) setRunPrompt(true)
    else void startRun({})
  }

  const showAllRuns = (): void => {
    runs.setFilter('all')
    setView('runs')
  }

  // A new node is centred in the canvas's view. Added from another view, it goes at the origin, and the canvas
  // fits every node into view when it is shown again.
  const placement = (): XYPosition => {
    const center = viewCenter.current?.()
    // A new card's height is unknown until it renders, so it is centred on a typical one.
    return center === undefined ? { x: 0, y: 0 } : { x: center.x - CARD_WIDTH / 2, y: center.y - 60 }
  }

  const busy = phase !== 'ready'
  const { workflows } = snapshot
  const pickerRows = useMemo(
    () => workflows.map((row): PickerRow => {
      const fault = openFault(row.definition)
      return fault === undefined ? row : { ...row, fault }
    }),
    [workflows],
  )
  const parentId = selectedId === undefined ? undefined : WorkflowId(selectedId)
  const embedChoices = workflows.filter(row => row.id !== parentId).map((row): EmbedChoice =>
    embedsCycle(parentId, row.id, saved.get(row.id)!, lookup) ? { ...row, fault: 'cycle' } : row)
  const embeddable = embedChoices.filter(choice => choice.fault === undefined)
  // The library leaves out the node types only a subworkflow's expansion places. A workflow has at most one boundary
  // node per side, so the library stops offering a second; a subworkflow node is added from the menu's workflows, so
  // the node types do not offer one linked to nothing.
  const addableNodeTypes = snapshot.nodeTypes.filter(type => !EXPANSION_NODE_TYPES.includes(type.type)
    && type.type !== SUBWORKFLOW_TYPE
    && ((type.type !== WORKFLOW_INPUT_TYPE && type.type !== WORKFLOW_OUTPUT_TYPE)
      || !definition.nodes.some(node => node.type === type.type)))
  const overlay = runs.record?.workflowId === selectedId ? runs.record : undefined
  const runRecords = overlay === undefined ? new Map() : runRecordsByNode(overlay)
  const runResult = overlay === undefined ? undefined : JSON.stringify(overlay.nodes, null, 2)
  // The analysis reads only the definition and the catalog, so it reruns exactly when they change.
  const analysis = useMemo(
    () => analyzeEditorGraph(definition, snapshot.nodeTypes),
    [definition, snapshot.nodeTypes],
  )
  const activeRuns = runs.runs.filter(row => isActiveRun(row)).length
  const waitingRequests = runs.runs.reduce((count, row) => count + row.pendingRequests, 0)
  return (
    <main
      className={css.page}
      aria-label={t('title')}
      onKeyDown={(event) => {
        if (busy || !(event.ctrlKey || event.metaKey) || isTextEntry(event.target)) return
        const key = event.key.toLowerCase()
        if (key === 'z' && !event.shiftKey) editor.undo()
        else if (key === 'y' || (key === 'z' && event.shiftKey)) editor.redo()
        else return
        event.preventDefault()
      }}
    >
      <header className={css.header}>
        <div className={css.editorTools}>
          <input
            className={css.workflowName}
            aria-label={t('workflows.name')}
            value={definition.name}
            readOnly={view !== 'canvas'}
            onChange={(event) => {
              editor.edit({ ...definition, name: event.currentTarget.value })
            }}
          />
          <WorkflowPicker
            disabled={busy}
            workflows={pickerRows}
            selectedId={selectedId}
            t={t}
            onCreate={editor.create}
            onSelect={editor.select}
            onDelete={(row) => { void editor.remove(row.id) }}
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
              nodeTypes={addableNodeTypes}
              workflows={embedChoices}
              t={t}
              onSelect={(nodeType: NodeTypeSummary) => { change(appendEditorNode(definition, nodeType, placement())) }}
              onSelectWorkflow={(row) => { change(appendSubworkflowNode(definition, row.id, saved.get(row.id)!, placement())) }}
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
            icon={<IconSettingsOutlineRegular size={14} />}
            aria-pressed={settingsOpen}
            onClick={() => { setSettingsOpen(open => !open) }}
          >
            {t('settings.title')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !editor.canUndo} title={t('action.undoKeys')} onClick={editor.undo}>
            {t('action.undo')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || !editor.canRedo} title={t('action.redoKeys')} onClick={editor.redo}>
            {t('action.redo')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={busy}
            onClick={() => { void editor.load() }}
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
              if (file !== undefined) void editor.importFile(file).then((opened) => { if (opened) setView('canvas') })
            }}
          />
          <Button
            size="sm"
            variant="outline"
            icon={<IconFolderOpenOutlineRegular size={14} />}
            disabled={busy}
            onClick={() => { importInput.current?.click() }}
          >
            {t('action.import')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<IconDownloadOutlineRegular size={14} />}
            disabled={busy}
            onClick={() => { downloadWorkflow(definition) }}
          >
            {t('action.export')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void editor.save() }}>
            {phase === 'saving' ? t('action.saving') : t('action.save')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlayOutlineRegular size={14} />}
            disabled={busy}
            onClick={run}
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
              renderRequest={renderRequest}
            />
          )}
          {view === 'canvas' && (
            <WorkflowGraphEditor
              definition={definition}
              revision={revision}
              nodeTypes={snapshot.nodeTypes}
              runRecords={runRecords}
              diagnostics={analysis?.byNode ?? new Map()}
              workflows={embeddable}
              lookup={lookup}
              clipboard={clipboard}
              onPaste={change}
              t={t}
              onChange={editor.edit}
              onError={setNotice}
              viewCenter={viewCenter}
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
          {view === 'description' && <DescriptionView ir={analysis?.ir} workflows={lookup} t={t} />}
          {view === 'canvas' && <DiagnosticsView diagnostics={analysis?.diagnostics} t={t} />}
          {notice !== undefined && <p className={css.notice} role="alert">{notice}</p>}
          {runPrompt && (
            <RunDialog
              ports={workflowInputPorts(definition)}
              busy={busy}
              t={t}
              onCancel={() => { setRunPrompt(false) }}
              onRun={(inputs) => { void startRun(inputs) }}
            />
          )}
        </section>
        {settingsOpen && (
          <WorkflowSettings
            definition={definition}
            t={t}
            onChange={change}
            onClose={() => { setSettingsOpen(false) }}
            onDelete={selectedId === undefined || busy ? undefined : () => { void editor.remove(selectedId) }}
          />
        )}
      </div>
    </main>
  )
}
