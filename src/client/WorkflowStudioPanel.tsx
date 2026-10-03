/** Main workflow authoring panel: workflow selection, save and run, and the canvas, execution, and runs views. */

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
  IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { XYPosition } from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { withCallees, type Callees } from '../shared/callees.ts'
import { SUBWORKFLOW_TYPE, embedFault } from '../shared/subworkflow.ts'
import { WorkflowId, type JsonObject, type NodeTypeSummary, type WorkflowKind } from '../shared/types.ts'
import {
  WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, workflowInputPorts,
} from '../shared/workflow-boundary.ts'
import { languageOf } from '../shared/language.ts'
import { analyzeEditorGraph } from './analysis-model.ts'
import { CARD_WIDTH } from './graph-model.ts'
import { AtomsPanel } from './AtomsPanel.tsx'
import { DiagnosticsView } from './DiagnosticsView.tsx'
import { ExecutionOrderView } from './ExecutionOrderView.tsx'
import { SourceView } from './SourceView.tsx'
import type { NS } from './locale.ts'
import { NodeLibraryMenu, WorkflowPicker } from './Menus.tsx'
import {
  appendAtomNode,
  appendEditorNode,
  appendSubworkflowNode,
  openFault,
  type EmbedChoice,
  type PickerRow,
} from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { RunDialog } from './RunDialog.tsx'
import { RunsView, type RequestRenderer } from './RunsView.tsx'
import { isActiveRun, runRecordsByNode } from './runs-model.ts'
import { downloadWorkflow } from './transfer.ts'
import { useAtomLibrary } from './use-atom-library.ts'
import { useRuns } from './use-runs.ts'
import { useWorkflowEditor } from './use-workflow-editor.ts'
import { WorkflowGraphEditor } from './WorkflowGraphEditor.tsx'
import { WorkflowSettings } from './WorkflowSettings.tsx'
import css from './WorkflowStudioPanel.module.css'

type View = 'canvas' | 'execution' | 'source' | 'runs'

const VIEWS = [
  { view: 'canvas', Icon: IconBranchOutlineRegular, kinds: ['run', 'code'] },
  { view: 'execution', Icon: IconListPenOutlineRegular, kinds: ['run', 'code'] },
  { view: 'source', Icon: IconCodeOutlineRegular, kinds: ['run', 'code'] },
  { view: 'runs', Icon: IconPlayOutlineRegular, kinds: ['run'] },
] as const satisfies readonly { view: View; Icon: unknown; kinds: readonly WorkflowKind[] }[]

/** Props the `main` slot passes to the panel. */
export interface WorkflowStudioPanelProps extends PropsLocale<typeof NS> {
  remote: WorkflowStudioRemoteNamespace
  /** Renders a paused node's signal form in a run workflow's Runs view. */
  renderRequest: RequestRenderer
}

/**
 * Main workflow authoring surface for both kinds of workflow. The open workflow's kind decides the rest: a run
 * workflow has the Runs view and the Run action, a code workflow has its language and atom folder instead.
 */
export function WorkflowStudioPanel({ t, remote, renderRequest }: WorkflowStudioPanelProps) {
  const editor = useWorkflowEditor(remote, t)
  const { snapshot, selectedId, definition, revision, phase, notice, setNotice, replace } = editor
  // The view last chosen; a workflow of a kind without that view shows the canvas instead.
  const [chosenView, setView] = useState<View>('canvas')
  const { kind } = definition
  // Code workflows compile instead of running, so they have no runs to start or show.
  const runnable = kind === 'run'
  const views = VIEWS.filter(entry => (entry.kinds as readonly WorkflowKind[]).includes(kind))
  const view = views.some(entry => entry.view === chosenView) ? chosenView : 'canvas'
  const runs = useRuns(remote, editor.fail, () => { setNotice(undefined) })
  const atoms = useAtomLibrary(remote, definition, editor.fail)
  const { library } = atoms
  // Set while the run dialog is collecting values for the workflow's declared inputs.
  const [runPrompt, setRunPrompt] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [atomsOpen, setAtomsOpen] = useState(true)
  const importInput = useRef<HTMLInputElement>(null)
  const viewCenter = useRef<() => XYPosition>()

  const language = languageOf(definition)
  const atomSyntax = language.functions?.atoms

  // The saved workflows, which subworkflow nodes link to by ID.
  const saved = useMemo(
    () => new Map(snapshot.workflows.map(row => [row.id, row.definition])),
    [snapshot.workflows],
  )
  const callees = useMemo<Callees>(() => ({
    atoms: library?.atoms ?? new Map(),
    workflows: saved,
    ...(library === undefined ? {} : { package: library.package }),
  }), [library, saved])

  // Atom and subworkflow nodes take their ports from what they call, so a folder read again, a workflow saved
  // again, or a workflow opened on them may move those ports.
  useEffect(() => {
    const signed = withCallees(definition, callees)
    if (signed !== definition) replace(signed)
  }, [callees, revision])

  /** Read the saved workflows and the atom folder again. */
  const refresh = (): void => {
    atoms.reload()
    void editor.load()
  }

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
  // A workflow embeds only workflows of its own kind, so the others are not offered at all.
  const embedChoices = workflows.filter(row => row.kind === kind && row.id !== parentId).map((row): EmbedChoice => {
    const fault = embedFault(definition, parentId, row.id, saved.get(row.id)!, id => saved.get(id))
    return fault === undefined ? row : { ...row, fault }
  })
  const embeddable = embedChoices.filter(choice => choice.fault === undefined)
  // The library offers the node types usable in this kind of workflow. A workflow has at most one boundary node per
  // side, so the library stops offering a second; a subworkflow node is added from the menu's workflows, so the node
  // types do not offer one linked to nothing.
  const addableNodeTypes = snapshot.nodeTypes.filter(type => type.kinds.includes(kind) && type.type !== SUBWORKFLOW_TYPE
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
    <main className={css.page} aria-label={t('title')}>
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
            {views.map(({ view: tab, Icon }) => (
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
              onSelect={(nodeType: NodeTypeSummary) => { replace(appendEditorNode(definition, nodeType, placement())) }}
              onSelectWorkflow={(row) => { replace(appendSubworkflowNode(definition, row.id, saved.get(row.id)!, placement())) }}
            />
          )}
        </div>
        <div className={css.actions}>
          {phase === 'loading' && <span className={css.headerStatus}>{t('status.loading')}</span>}
          {runnable && activeRuns > 0 && (
            <button type="button" className={css.runBadge} onClick={showAllRuns}>
              {activeRuns} {t('runs.activeCount')}
            </button>
          )}
          {runnable && waitingRequests > 0 && (
            <button type="button" className={css.runBadge} data-status="waiting" onClick={showAllRuns}>
              {waitingRequests} {t('runs.waitingCount')}
            </button>
          )}
          {atomSyntax !== undefined && (
            <Button
              size="sm"
              variant="outline"
              icon={<IconWorkspaceTreeOutlineRegular size={14} />}
              aria-pressed={atomsOpen}
              onClick={() => { setAtomsOpen(open => !open) }}
            >
              {t('atoms.panel')}
            </Button>
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
          <Button
            size="sm"
            variant="outline"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={busy}
            onClick={refresh}
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
          {runnable && (
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlayOutlineRegular size={14} />}
              disabled={busy}
              onClick={run}
            >
              {phase === 'running' ? t('action.running') : t('action.run')}
            </Button>
          )}
        </div>
      </header>

      <div className={css.workspace}>
        {atomsOpen && atomSyntax !== undefined && (
          <AtomsPanel
            definition={definition}
            language={language}
            syntax={atomSyntax}
            library={library}
            remote={remote}
            t={t}
            onChange={replace}
            onAdd={(atom) => {
              replace(appendAtomNode(definition, atom, placement()))
              setView('canvas')
            }}
            onReload={atoms.reload}
            onClose={() => { setAtomsOpen(false) }}
          />
        )}
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
              callees={callees}
              workflows={embeddable}
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
          {view === 'source' && (
            <SourceView ir={analysis?.ir} language={language} callees={callees} t={t} />
          )}
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
            callees={callees}
            t={t}
            onChange={replace}
            onClose={() => { setSettingsOpen(false) }}
            onDelete={selectedId === undefined || busy ? undefined : () => { void editor.remove(selectedId) }}
          />
        )}
      </div>
    </main>
  )
}
