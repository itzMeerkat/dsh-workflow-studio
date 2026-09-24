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
import { useEffect, useMemo, useRef, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import { withCallees, type Callees } from '../shared/callees.ts'
import { SUBWORKFLOW_TYPE, embedFault } from '../shared/subworkflow.ts'
import {
  WorkflowId, type DagWorkflowDefinition, type NodeTypeSummary, type SavedWorkflow, type WorkflowKind,
  type WorkflowStudioSnapshot,
} from '../shared/types.ts'
import {
  WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, workflowInputPorts,
} from '../shared/workflow-boundary.ts'
import {
  CODE_LANGUAGES, atomLibrary, languageOf, type AtomLibrary,
} from '../shared/language.ts'
import { atomFilesSchema } from '../shared/workflow-schema.ts'
import { analyzeEditorGraph } from './analysis-model.ts'
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
  formatEditorDefinition,
  nextWorkflowName,
  openFault,
  parseEditorDefinition,
  parseSnapshot,
  type WorkflowRow,
} from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { RunDialog } from './RunDialog.tsx'
import { RunsView, type RequestRenderer } from './RunsView.tsx'
import { isActiveRun, runRecordsByNode } from './runs-model.ts'
import { downloadWorkflow, importedWorkflowName, parseImportedWorkflow } from './transfer.ts'
import { useRuns } from './use-runs.ts'
import { WorkflowGraphEditor } from './WorkflowGraphEditor.tsx'
import { WorkflowSettings } from './WorkflowSettings.tsx'
import { boundaryNode } from './workflow-ports.ts'
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
  /** Which kind of workflow this panel lists, creates and edits. */
  kind: WorkflowKind
  /** Renders a paused node's signal form; `code` workflows never run, so that panel passes undefined. */
  renderRequest: RequestRenderer | undefined
}

/** Main workflow authoring surface. */
export function WorkflowStudioPanel({ t, remote, renderRequest, kind }: WorkflowStudioPanelProps) {
  const [snapshot, setSnapshot] = useState<WorkflowStudioSnapshot>({ workflows: [], nodeTypes: [] })
  const [selectedId, setSelectedId] = useState<string>()
  const [definition, setDefinition] = useState<DagWorkflowDefinition>(() => emptyDefinition('workflow-1', kind))
  // Incremented when the canvas must discard its local graph and reload `definition`.
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<View>('canvas')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'running'>('loading')
  const [notice, setNotice] = useState<string>()
  // Code workflows compile instead of running, so their panel has no runs to poll or start.
  const runnable = kind === 'run'
  const runs = useRuns(remote, setNotice, runnable)
  // Set while the run dialog is collecting values for the workflow's declared inputs.
  const [runPrompt, setRunPrompt] = useState(false)
  // The atoms read from the workflow's atom folder; reading again after a refresh picks up edited files.
  const [library, setLibrary] = useState<AtomLibrary>()
  const [atomsRead, setAtomsRead] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const [atomsOpen, setAtomsOpen] = useState(true)
  const importInput = useRef<HTMLInputElement>(null)

  const replaceDefinition = (next: DagWorkflowDefinition): void => {
    setDefinition(next)
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  /** The definition, or an error naming why this panel cannot edit it. */
  const editable = (next: DagWorkflowDefinition): DagWorkflowDefinition => {
    const fault = openFault(next, kind)
    if (fault !== undefined) throw new Error(`${t(fault.key)} ${fault.detail}`)
    return next
  }

  const select = (workflow: WorkflowRow): void => {
    try {
      replaceDefinition(editable(parseEditorDefinition(workflow.definition)))
      setSelectedId(workflow.id)
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  const load = async (preferredId?: string): Promise<void> => {
    setAtomsRead(value => value + 1)
    setPhase('loading')
    setNotice(undefined)
    // The Host sends only this panel's kind of workflows, and only the node types usable in them.
    const next = await callRemote(() => remote.snapshot(kind), parseSnapshot, setNotice)
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

  const language = languageOf(definition)
  const atomSyntax = language.functions?.atoms
  useEffect(() => {
    const folder = definition.atomFolder
    // The atoms panel shows the folder as being read until its atoms arrive.
    setLibrary(undefined)
    if (folder === undefined || atomSyntax === undefined) return
    let current = true
    void callRemote(
      () => remote.atomFiles(folder, definition.language!),
      files => atomLibrary(atomFilesSchema.parse(JSON.parse(files)), atomSyntax),
      setNotice,
    ).then((next) => { if (current) setLibrary(next) })
    return () => { current = false }
  }, [definition.atomFolder, definition.language, atomsRead])

  // The saved workflows of this panel's kind, which subworkflow nodes link to by ID.
  const saved = useMemo(
    () => new Map(snapshot.workflows.map(row => [row.id, parseEditorDefinition(row.definition)])),
    [snapshot.workflows],
  )
  const callees = useMemo<Callees>(() => ({ atoms: library?.atoms ?? new Map(), workflows: saved }), [library, saved])

  // Atom and subworkflow nodes take their ports from what they call, so a folder read again, a workflow saved
  // again, or a workflow opened on them may move those ports.
  useEffect(() => {
    const signed = withCallees(definition, callees)
    if (JSON.stringify(signed) !== JSON.stringify(definition)) replaceDefinition(signed)
  }, [callees, revision])

  /** Save the edited definition; failures show as the notice. */
  const persist = async (): Promise<SavedWorkflow | undefined> => {
    const source = formatEditorDefinition(definition)
    const saved = await callRemote(
      () => selectedId === undefined ? remote.save(source) : remote.update(selectedId, source),
      json => JSON.parse(json) as SavedWorkflow,
      setNotice,
    )
    if (saved !== undefined) setSelectedId(saved.workflowId)
    return saved
  }

  const save = async (): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const saved = await persist()
    if (saved === undefined) {
      setPhase('ready')
      return
    }
    // Saving a workflow with an atom folder also writes its function into that folder, in a file named after its ID.
    const written = definition.atomFolder === undefined || atomSyntax === undefined
      ? undefined
      : `${saved.workflowId}${atomSyntax.outputSuffix}`
    await load(saved.workflowId)
    setNotice(written === undefined
      ? t('notice.saved')
      : saved.sourceError === undefined
        ? `${t('notice.savedFile')} ${written}`
        : `${t('notice.savedNoFile')} ${saved.sourceError}`)
  }

  /** Save, start a run without waiting for it, and open it in the Runs view. */
  const startRun = async (inputs: string): Promise<void> => {
    setRunPrompt(false)
    setPhase('running')
    setNotice(undefined)
    const saved = await persist()
    const runId = saved === undefined
      ? undefined
      : await callRemote(() => remote.start(saved.workflowId, inputs), id => id, setNotice)
    if (runId !== undefined) {
      runs.setFilter('workflow')
      setView('runs')
      runs.select(runId)
    }
    setPhase('ready')
  }

  /** A workflow that declares inputs asks for their values first; one that declares none just runs. */
  const run = (): void => {
    if (workflowInputPorts(definition).length > 0) setRunPrompt(true)
    else void startRun('{}')
  }

  /** Load one picked file into the editor as an unsaved workflow. */
  const importFile = async (file: File): Promise<void> => {
    try {
      const imported = editable(parseImportedWorkflow(await file.text()))
      setSelectedId(undefined)
      replaceDefinition({ ...imported, name: importedWorkflowName(imported.name, workflows) })
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
  const { workflows } = snapshot
  const parentId = selectedId === undefined ? undefined : WorkflowId(selectedId)
  const embeddable = workflows.filter(row =>
    embedFault(definition, parentId, row.id, saved.get(row.id)!, id => saved.get(id), language.functions !== undefined) === undefined)
  const views = VIEWS.filter(entry => (entry.kinds as readonly WorkflowKind[]).includes(kind))
  // A workflow has at most one boundary node per side, so the library stops offering a second; a subworkflow
  // node is added from the menu's workflows, so the node types do not offer one linked to nothing.
  const addableNodeTypes = snapshot.nodeTypes.filter(type => type.type !== SUBWORKFLOW_TYPE
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
              setDefinition({ ...definition, name: event.currentTarget.value })
            }}
          />
          <WorkflowPicker
            disabled={busy}
            workflows={workflows}
            selectedId={selectedId}
            t={t}
            onCreate={() => {
              setSelectedId(undefined)
              replaceDefinition(emptyDefinition(nextWorkflowName(workflows, kind), kind))
            }}
            onSelect={select}
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
              workflows={embeddable}
              t={t}
              onSelect={(nodeType: NodeTypeSummary) => { replaceDefinition(appendEditorNode(definition, nodeType)) }}
              onSelectWorkflow={(row) => { replaceDefinition(appendSubworkflowNode(definition, row.id, saved.get(row.id)!)) }}
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
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void save() }}>
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
            onChange={replaceDefinition}
            onAdd={(atom) => {
              replaceDefinition(appendAtomNode(definition, atom))
              setView('canvas')
            }}
            onReload={() => { setAtomsRead(value => value + 1) }}
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
            library={library}
            callees={callees}
            t={t}
            onChange={replaceDefinition}
            onClose={() => { setSettingsOpen(false) }}
          />
        )}
      </div>
    </main>
  )
}

/**
 * A new workflow, holding only its two boundary nodes.
 *
 * They are ordinary nodes, so a new workflow could start without them; seeding them means the
 * place to declare an input is on screen from the start instead of hiding in the node library.
 * @param name - The new workflow's name.
 * @param kind - The panel's kind; a code workflow starts in the first code language.
 */
function emptyDefinition(name: string, kind: WorkflowKind): DagWorkflowDefinition {
  return {
    name,
    kind,
    ...(kind === 'code' ? { language: CODE_LANGUAGES[0]!.name } : {}),
    nodes: [boundaryNode('inputs'), boundaryNode('outputs')],
    edges: [],
  }
}
