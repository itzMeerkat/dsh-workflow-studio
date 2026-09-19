/**
 * Browser workflow editor and sidebar registration.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  Button,
  IconBranchOutline16,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconFolderClose16,
  IconListPenOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ExecutionOrderView } from './ExecutionOrderView.tsx'
import { RunsView, type RunAction, type RunsFilter } from './RunsView.tsx'
import { WorkflowGraphEditor } from './WorkflowGraphEditor.tsx'
import { messageOf } from '../errors.ts'
import type { DagWorkflowDefinition, NodeTypeSummary, WorkflowRunRecord, WorkflowRunSummary, WorkflowStudioSnapshot } from '../types.ts'
import type { WorkflowRow } from './model.ts'
import {
  appendEditorNode,
  formatEditorDefinition,
  filterNodeTypes,
  filterWorkflows,
  nextWorkflowName,
  parseEditorDefinition,
  parseSnapshot,
} from './model.ts'
import workflowStudioRemote, { type WorkflowStudioRemoteNamespace } from './remote.ts'
import {
  isActiveRun,
  parseRunRecord,
  parseRunSummaries,
  runRecordsByNode,
} from './runs-model.ts'
import css from './WorkflowStudioPanel.module.css'

const NS = 'workflowStudio'
const PANEL_ID = 'dsh-workflow-studio' as MainPanelId

/** Browser services required before the editor mounts its Remote and slots. */
export const inject = ['slots', 'locale', 'remote']

/** An empty workflow; Studio registers no nodes, so the template names none. */
function createDefaultDefinition(name: string): DagWorkflowDefinition {
  return { name, nodes: [], edges: [] }
}

const INITIAL_DEFINITION = createDefaultDefinition('workflow-1')

/** How often the panel refreshes run statuses while it is mounted. */
const RUNS_REFRESH_MS = 2000

interface WorkflowStudioPanelProps extends PropsLocale<typeof NS> {
  remote: WorkflowStudioRemoteNamespace
}

/** Main workflow authoring surface. */
export function WorkflowStudioPanel({ t, remote }: WorkflowStudioPanelProps) {
  const [snapshot, setSnapshot] = useState<WorkflowStudioSnapshot>({ workflows: [], nodeTypes: [] })
  const [selectedId, setSelectedId] = useState<string>()
  const [definition, setDefinition] = useState<DagWorkflowDefinition>(INITIAL_DEFINITION)
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'canvas' | 'execution' | 'runs'>('canvas')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'saving' | 'running'>('loading')
  const [notice, setNotice] = useState<string>()
  const [runs, setRuns] = useState<readonly WorkflowRunSummary[]>([])
  const [runsFilter, setRunsFilter] = useState<RunsFilter>('workflow')
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [runRecord, setRunRecord] = useState<WorkflowRunRecord>()
  const [runBusy, setRunBusy] = useState(false)
  const selectedRunRef = useRef<string | undefined>(undefined)
  selectedRunRef.current = selectedRunId

  const adoptSource = (nextSource: string): void => {
    const nextDefinition = parseEditorDefinition(nextSource)
    setDefinition(nextDefinition)
    setRevision(value => value + 1)
  }

  const load = async (preferredId?: string): Promise<void> => {
    setPhase('loading')
    setNotice(undefined)
    let response: RemoteResult<string>
    try {
      response = await remote.snapshot()
    } catch (error: unknown) {
      setNotice(messageOf(error))
      setPhase('ready')
      return
    }
    if (!response.ok) {
      setNotice(response.error.message)
      setPhase('ready')
      return
    }
    let next: WorkflowStudioSnapshot
    try {
      next = parseSnapshot(response.value)
    } catch (error: unknown) {
      setNotice(messageOf(error))
      setPhase('ready')
      return
    }
    setSnapshot(next)
    const selected = next.workflows.find(row => row.id === preferredId)
      ?? next.workflows.find(row => row.id === selectedId)
      ?? next.workflows[0]
    if (selected !== undefined) {
      setSelectedId(selected.id)
      try {
        adoptSource(selected.definition)
      } catch (error: unknown) {
        setNotice(messageOf(error))
      }
    }
    setPhase('ready')
  }

  useEffect(() => {
    void load()
  }, [])

  /** Read the run list and the selected run; failures surface as a notice. */
  const refreshRuns = async (): Promise<void> => {
    try {
      const list = await remote.listRuns()
      if (!list.ok) {
        setNotice(list.error.message)
        return
      }
      setRuns(parseRunSummaries(list.value))
      const runId = selectedRunRef.current
      if (runId === undefined) return
      const detail = await remote.getRun(runId)
      if (!detail.ok) {
        setNotice(detail.error.message)
        return
      }
      if (selectedRunRef.current === runId) setRunRecord(parseRunRecord(detail.value))
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  useEffect(() => {
    void refreshRuns()
    const timer = setInterval(() => { void refreshRuns() }, RUNS_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [])

  const selectRun = (runId: string): void => {
    selectedRunRef.current = runId
    setSelectedRunId(runId)
    setRunRecord(undefined)
    void refreshRuns()
  }

  /** Apply a run control or answer and show the record it returns. */
  const controlRun = async (call: () => Promise<RemoteResult<string>>): Promise<void> => {
    setRunBusy(true)
    setNotice(undefined)
    try {
      const response = await call()
      if (!response.ok) {
        setNotice(response.error.message)
        return
      }
      setRunRecord(parseRunRecord(response.value))
      await refreshRuns()
    } catch (error: unknown) {
      setNotice(messageOf(error))
    } finally {
      setRunBusy(false)
    }
  }

  const onRunAction = (action: RunAction): void => {
    const runId = selectedRunRef.current
    if (runId !== undefined) void controlRun(() => remote[action](runId))
  }

  const onAnswer = (nodeId: string, requestId: string, answer: AskUserQuestionAnswer): void => {
    const runId = selectedRunRef.current
    if (runId !== undefined) void controlRun(() => remote.answer(runId, nodeId, requestId, JSON.stringify(answer)))
  }

  const select = (workflow: WorkflowRow): void => {
    try {
      adoptSource(workflow.definition)
      setSelectedId(workflow.id)
      setNotice(undefined)
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  const createNew = (): void => {
    const nextDefinition = createDefaultDefinition(nextWorkflowName(snapshot.workflows))
    setSelectedId(undefined)
    setDefinition(nextDefinition)
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  const persist = async (): Promise<string | undefined> => {
    let response: RemoteResult<string>
    const source = formatEditorDefinition(definition)
    try {
      response = selectedId === undefined
        ? await remote.save(source)
        : await remote.update(selectedId, source)
    } catch (error: unknown) {
      setNotice(messageOf(error))
      return undefined
    }
    if (!response.ok) {
      setNotice(response.error.message)
      return undefined
    }
    setSelectedId(response.value)
    return response.value
  }

  const save = async (): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const workflowId = await persist()
    if (workflowId !== undefined) {
      await load(workflowId)
      setNotice(t('notice.saved'))
    } else {
      setPhase('ready')
    }
  }

  /** Save, start a run without waiting for it, and open it in the Runs view. */
  const run = async (): Promise<void> => {
    setPhase('running')
    setNotice(undefined)
    const workflowId = await persist()
    if (workflowId === undefined) {
      setPhase('ready')
      return
    }
    try {
      const response = await remote.start(workflowId)
      if (!response.ok) {
        setNotice(response.error.message)
        return
      }
      setRunsFilter('workflow')
      setView('runs')
      selectRun(response.value)
    } catch (error: unknown) {
      setNotice(messageOf(error))
    } finally {
      setPhase('ready')
    }
  }

  const addNode = (nodeType: NodeTypeSummary): void => {
    setDefinition(appendEditorNode(definition, nodeType))
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  const busy = phase !== 'ready'
  const overlay = runRecord !== undefined && runRecord.workflowId === selectedId ? runRecord : undefined
  const runRecords = overlay === undefined ? new Map() : runRecordsByNode(overlay)
  const runResult = overlay === undefined ? undefined : JSON.stringify(overlay.nodes, null, 2)
  const activeRuns = runs.filter(row => isActiveRun(row)).length
  const awaitingInput = runs.reduce((count, row) => count + row.awaitingInput, 0)
  return (
    <main className={css.page}>
      <header className={css.header}>
        <div>
          <h1>{t('title')}</h1>
        </div>
        <div className={css.actions}>
          {activeRuns > 0 && (
            <button type="button" className={css.runBadge} onClick={() => { setRunsFilter('all'); setView('runs') }}>
              {activeRuns} {t('runs.activeCount')}
            </button>
          )}
          {awaitingInput > 0 && (
            <button
              type="button"
              className={css.runBadge}
              data-status="awaiting-input"
              onClick={() => { setRunsFilter('all'); setView('runs') }}
            >
              {awaitingInput} {t('runs.awaitingCount')}
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
          <div className={css.editorHead}>
            <div className={css.editorTools}>
              <WorkflowPicker
                disabled={busy}
                workflows={snapshot.workflows}
                selectedId={selectedId}
                t={t}
                onCreate={createNew}
                onSelect={select}
              />
              <label className={css.workflowName}>
                <span>{t('workflows.name')}</span>
                <input
                  value={definition.name}
                  readOnly={view !== 'canvas'}
                  onChange={(event) => {
                    setDefinition({ ...definition, name: event.currentTarget.value })
                  }}
                />
              </label>
              <div className={css.viewTabs} role="tablist" aria-label={t('view.label')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'canvas'}
                  onClick={() => { setView('canvas') }}
                >
                  <IconBranchOutline16 size={14} />
                  {t('view.canvas')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'execution'}
                  onClick={() => { setView('execution') }}
                >
                  <IconListPenOutline16 size={14} />
                  {t('view.execution')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'runs'}
                  onClick={() => { setView('runs') }}
                >
                  <IconPlayOutline16 size={14} />
                  {t('view.runs')}
                </button>
              </div>
              {view === 'canvas' && (
                <NodeLibraryMenu
                  disabled={busy}
                  nodeTypes={snapshot.nodeTypes}
                  t={t}
                  onSelect={addNode}
                />
              )}
            </div>
            <span>{phase === 'loading' ? t('status.loading') : t('status.ready')}</span>
          </div>

          {view === 'runs' && (
            <RunsView
              t={t}
              runs={runs}
              filter={runsFilter}
              currentWorkflowId={selectedId}
              selectedRunId={selectedRunId}
              record={runRecord}
              nodeTypes={snapshot.nodeTypes}
              busy={runBusy}
              onFilter={setRunsFilter}
              onSelect={selectRun}
              onAction={onRunAction}
              onAnswer={onAnswer}
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

function WorkflowPicker({
  disabled,
  workflows,
  selectedId,
  t,
  onCreate,
  onSelect,
}: {
  readonly disabled: boolean
  readonly workflows: readonly WorkflowRow[]
  readonly selectedId: string | undefined
  readonly t: WorkflowStudioPanelProps['t']
  readonly onCreate: () => void
  readonly onSelect: (workflow: WorkflowRow) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const matches = filterWorkflows(workflows, query)
  usePickerLifecycle(open, setOpen, rootRef, searchRef)

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  return (
    <div className={css.workflowPicker} ref={rootRef}>
      <Tooltip label={t('workflows.switch')} side="bottom" delayMs={500}>
        <Button
          size="sm"
          variant="outline"
          icon={<IconFolderClose16 size={14} />}
          disabled={disabled}
          aria-label={t('workflows.switch')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setQuery('')
            setOpen(value => !value)
          }}
        />
      </Tooltip>
      {open && (
        <div className={css.workflowMenu} role="dialog" aria-label={t('workflows.title')}>
          <label className={css.menuSearch}>
            <IconSearchOutline16 size={14} />
            <input
              ref={searchRef}
              aria-label={t('workflows.search')}
              placeholder={t('workflows.search')}
              value={query}
              onChange={event => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.workflowMenuList}>
            <button
              type="button"
              className={`${css.workflowMenuRow} ${
                selectedId === undefined ? css.workflowMenuRowActive : ''
              }`}
              onClick={() => {
                onCreate()
                close()
              }}
            >
              <IconPlusOutline16 size={14} />
              <span>{t('workflows.new')}</span>
              {selectedId === undefined && <IconCheckOutline16 size={14} />}
            </button>
            {matches.length === 0
              ? <p className={css.menuEmpty}>{t('workflows.empty')}</p>
              : matches.map(workflow => (
                  <button
                    type="button"
                    className={`${css.workflowMenuRow} ${
                      selectedId === workflow.id ? css.workflowMenuRowActive : ''
                    }`}
                    key={workflow.id}
                    onClick={() => {
                      onSelect(workflow)
                      close()
                    }}
                  >
                    <strong>{workflow.name}</strong>
                    {selectedId === workflow.id && <IconCheckOutline16 size={14} />}
                  </button>
                ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NodeLibraryMenu({
  disabled,
  nodeTypes,
  t,
  onSelect,
}: {
  readonly disabled: boolean
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly t: WorkflowStudioPanelProps['t']
  readonly onSelect: (nodeType: NodeTypeSummary) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const matches = filterNodeTypes(nodeTypes, query)
  usePickerLifecycle(open, setOpen, rootRef, searchRef)

  return (
    <div className={css.nodePicker} ref={rootRef}>
      <Button
        size="sm"
        variant="outline"
        icon={<IconPlusOutline16 size={14} />}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setQuery('')
          setOpen(value => !value)
        }}
      >
        <span>{t('nodes.add')}</span>
        <IconChevronDownOutline14 size={12} />
      </Button>
      {open && (
        <div className={css.nodeMenu} role="dialog" aria-label={t('nodes.title')}>
          <label className={css.menuSearch}>
            <IconSearchOutline16 size={14} />
            <input
              ref={searchRef}
              aria-label={t('nodes.search')}
              placeholder={t('nodes.search')}
              value={query}
              onChange={event => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.nodeMenuList}>
            {matches.length === 0
              ? <p className={css.menuEmpty}>{t('nodes.empty')}</p>
              : matches.map(node => (
                  <button
                    type="button"
                    className={css.nodeType}
                    key={node.type}
                    onClick={() => {
                      onSelect(node)
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    <span className={css.nodeTypeTitle}>
                      <strong>{node.label}</strong>
                      <code>{node.type}</code>
                    </span>
                    <span>{node.description}</span>
                    <small>{t('nodes.source')}: {node.sourcePlugin}</small>
                  </button>
                ))}
          </div>
        </div>
      )}
    </div>
  )
}

function usePickerLifecycle(
  open: boolean,
  setOpen: (open: boolean) => void,
  rootRef: RefObject<HTMLDivElement | null>,
  searchRef: RefObject<HTMLInputElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, rootRef, searchRef, setOpen])
}

function WorkflowStudioIcon() {
  return <IconBranchOutline16 size={16} />
}

const dictionaries = {
  zh: {
    'tab.editor': 'Workflow Studio',
    'title': 'Workflow Studio',
    'action.refresh': '刷新',
    'action.save': '保存',
    'action.saving': '保存中',
    'action.run': '运行',
    'action.running': '运行中',
    'action.apply': '应用',
    'action.delete': '删除',
    'workflows.title': '工作流',
    'workflows.new': '新建工作流',
    'workflows.name': '名称',
    'workflows.switch': '切换工作流',
    'workflows.search': '搜索工作流',
    'workflows.empty': '没有匹配的工作流。',
    'nodes.title': '节点库',
    'nodes.add': '添加节点',
    'nodes.search': '搜索节点',
    'nodes.empty': '没有匹配的节点。',
    'nodes.source': '来源',
    'view.label': '编辑器视图',
    'view.canvas': '画布',
    'view.execution': '执行顺序',
    'execution.title': '执行顺序',
    'execution.stage': '阶段',
    'execution.stages': '个阶段',
    'execution.nodes': '个节点',
    'execution.cycle': '以下节点位于循环依赖中',
    'inspector.title': '节点设置',
    'inspector.close': '关闭节点设置',
    'inspector.label': '名称',
    'inspector.config': '配置 JSON',
    'result.title': '运行结果',
    'result.empty': '运行工作流后在此查看节点状态和输出。',
    'status.loading': '加载中',
    'status.ready': '可编辑',
    'notice.saved': '工作流已保存。',
    'notice.connectPorts': '连线必须连接明确的输入和输出端口。',
    'notice.incompatiblePorts': '输出类型与输入类型不兼容。',
    'notice.inputConnected': '每个输入端口只能连接一条边。',
    'notice.configObject': '节点配置必须是 JSON 对象。',
    'view.runs': '运行',
    'runs.filter': '运行范围',
    'runs.filter.workflow': '当前工作流',
    'runs.filter.all': '全部',
    'runs.active': '进行中',
    'runs.history': '历史',
    'runs.empty': '还没有运行。',
    'runs.select': '选择一个运行查看详情。',
    'runs.started': '开始于',
    'runs.duration': '耗时',
    'runs.node': '节点',
    'runs.status': '状态',
    'runs.attempts': '调用次数',
    'runs.detail': '输出与错误',
    'runs.activeCount': '个运行进行中',
    'runs.awaitingCount': '个问题待回答',
    'action.pause': '暂停',
    'action.resume': '恢复',
    'action.cancel': '取消运行',
    'runStatus.awaiting': '待回答',
    'runStatus.running': '运行中',
    'runStatus.paused': '已暂停',
    'runStatus.interrupted': '已中断',
    'runStatus.completed': '已完成',
    'runStatus.failed': '失败',
    'runStatus.cancelled': '已取消',
    'nodeStatus.pending': '等待中',
    'nodeStatus.running': '运行中',
    'nodeStatus.awaiting-input': '待回答',
    'nodeStatus.completed': '已完成',
    'nodeStatus.skipped': '已跳过',
    'nodeStatus.failed': '失败',
    'nodeStatus.cancelled': '已取消',
    'questions.title': '等待你的回答',
    'questions.from': '来自节点',
    'questions.other': '其他（自定义回答）',
    'questions.submit': '提交回答',
  },
  en: {
    'tab.editor': 'Workflow Studio',
    'title': 'Workflow Studio',
    'action.refresh': 'Refresh',
    'action.save': 'Save',
    'action.saving': 'Saving',
    'action.run': 'Run',
    'action.running': 'Running',
    'action.apply': 'Apply',
    'action.delete': 'Delete',
    'workflows.title': 'Workflows',
    'workflows.new': 'New workflow',
    'workflows.name': 'Name',
    'workflows.switch': 'Switch workflow',
    'workflows.search': 'Search workflows',
    'workflows.empty': 'No matching workflows.',
    'nodes.title': 'Node library',
    'nodes.add': 'Add node',
    'nodes.search': 'Search nodes',
    'nodes.empty': 'No matching nodes.',
    'nodes.source': 'Source',
    'view.label': 'Editor view',
    'view.canvas': 'Canvas',
    'view.execution': 'Execution order',
    'execution.title': 'Execution order',
    'execution.stage': 'Stage',
    'execution.stages': 'stages',
    'execution.nodes': 'nodes',
    'execution.cycle': 'These nodes are in a dependency cycle',
    'inspector.title': 'Node settings',
    'inspector.close': 'Close node settings',
    'inspector.label': 'Label',
    'inspector.config': 'Configuration JSON',
    'result.title': 'Run result',
    'result.empty': 'Run a workflow to inspect node states and outputs.',
    'status.loading': 'Loading',
    'status.ready': 'Editable',
    'notice.saved': 'Workflow saved.',
    'notice.connectPorts': 'Connections must join explicit input and output ports.',
    'notice.incompatiblePorts': 'The output and input port types are incompatible.',
    'notice.inputConnected': 'Each input port accepts only one edge.',
    'notice.configObject': 'Node configuration must be a JSON object.',
    'view.runs': 'Runs',
    'runs.filter': 'Run scope',
    'runs.filter.workflow': 'This workflow',
    'runs.filter.all': 'All',
    'runs.active': 'Active',
    'runs.history': 'History',
    'runs.empty': 'No runs yet.',
    'runs.select': 'Select a run to see its details.',
    'runs.started': 'Started',
    'runs.duration': 'Took',
    'runs.node': 'Node',
    'runs.status': 'Status',
    'runs.attempts': 'Calls',
    'runs.detail': 'Outputs and errors',
    'runs.activeCount': 'active runs',
    'runs.awaitingCount': 'questions waiting',
    'action.pause': 'Pause',
    'action.resume': 'Resume',
    'action.cancel': 'Cancel run',
    'runStatus.awaiting': 'Awaiting input',
    'runStatus.running': 'Running',
    'runStatus.paused': 'Paused',
    'runStatus.interrupted': 'Interrupted',
    'runStatus.completed': 'Completed',
    'runStatus.failed': 'Failed',
    'runStatus.cancelled': 'Cancelled',
    'nodeStatus.pending': 'Pending',
    'nodeStatus.running': 'Running',
    'nodeStatus.awaiting-input': 'Awaiting input',
    'nodeStatus.completed': 'Completed',
    'nodeStatus.skipped': 'Skipped',
    'nodeStatus.failed': 'Failed',
    'nodeStatus.cancelled': 'Cancelled',
    'questions.title': 'Waiting for your answer',
    'questions.from': 'from node',
    'questions.other': 'Other (custom answer)',
    'questions.submit': 'Submit answer',
  },
} as const

type Dict = (typeof dictionaries)['zh']
export type WorkflowStudioKey = keyof Dict

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    workflowStudio: WorkflowStudioKey
  }
}

/** Register the workflow editor and its Remote namespace. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'workflow-studio:dictionaries',
  )
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => {
      const remote = ctx.get('remote.workflowStudio') as WorkflowStudioRemoteNamespace | undefined
      if (remote === undefined) throw new Error('workflowStudio Remote is not mounted')
      return { remote }
    },
  }, WorkflowStudioPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 80,
    label: () => t('tab.editor'),
    locale: NS,
  }, WorkflowStudioIcon))

  return ctx.remote.$mount(workflowStudioRemote)
}
