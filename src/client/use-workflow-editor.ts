/** The saved workflows, the workflow open in the editor, and the actions that load, save, delete, and import them. */

import { useEffect, useRef, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import type { DagWorkflowDefinition, SavedWorkflow, WorkflowStudioSnapshot } from '../shared/types.ts'
import { failureText, refusalText } from './failure-text.ts'
import type { Translate } from './locale.ts'
import { nextWorkflowName, openFault, type WorkflowRow } from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { importedWorkflowName, parseImportedWorkflow } from './transfer.ts'
import { boundaryNode } from './workflow-ports.ts'

/** How many undo steps the editor keeps for the open workflow. */
const HISTORY_LIMIT = 100

/** Canvas edits closer together than this, such as the steps of one drag or one word typed, undo as one step. */
const COALESCE_MS = 600

/** Earlier and undone versions of the open definition, nearest last in `past` and first in `future`. */
interface History {
  readonly past: readonly DagWorkflowDefinition[]
  readonly future: readonly DagWorkflowDefinition[]
}

const NO_HISTORY: History = { past: [], future: [] }

/** What the editor is doing; every phase but `ready` disables the actions that would race it. */
export type EditorPhase = 'loading' | 'ready' | 'saving' | 'running'

/**
 * Hold the editor's workflow state and load the saved workflows once mounted.
 * @param remote - The `workflowStudio` Remote.
 * @param t - Translate.
 * @returns The state, and the actions that change it; each action reports its outcome or failure as the notice.
 */
export function useWorkflowEditor(remote: WorkflowStudioRemoteNamespace, t: Translate) {
  const [snapshot, setSnapshot] = useState<WorkflowStudioSnapshot>({ workflows: [], nodeTypes: [] })
  const [selectedId, setSelectedId] = useState<string>()
  const [definition, setDefinition] = useState<DagWorkflowDefinition>(() => emptyDefinition('workflow-1'))
  // Incremented when the canvas must discard its local graph and reload `definition`.
  const [revision, setRevision] = useState(0)
  const [phase, setPhase] = useState<EditorPhase>('loading')
  const [notice, setNotice] = useState<string>()
  const [history, setHistory] = useState<History>(NO_HISTORY)
  // When the last canvas edit was recorded; 0 after any other change, so the next edit starts a new step.
  const lastEdit = useRef(0)

  /** Show a failed Remote call as the notice, a refusal worded in the active locale. */
  const fail = (failure: unknown): void => { setNotice(failureText(failure, t)) }

  /** Show a definition and make the canvas reload it, leaving the undo history alone. */
  const sync = (next: DagWorkflowDefinition): void => {
    setDefinition(next)
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  /** Open another workflow; its edits start a new undo history. */
  const open = (next: DagWorkflowDefinition): void => {
    setHistory(NO_HISTORY)
    lastEdit.current = 0
    sync(next)
  }

  /** Record the open definition as one undo step before it is replaced. */
  const record = (): void => {
    setHistory(({ past }) => ({ past: [...past, definition].slice(-HISTORY_LIMIT), future: [] }))
  }

  /** Change the open definition as one undo step, and make the canvas reload it. */
  const change = (next: DagWorkflowDefinition): void => {
    record()
    lastEdit.current = 0
    sync(next)
  }

  /** Change the open definition in place, as the canvas and the name field do; edits in quick succession undo together. */
  const edit = (next: DagWorkflowDefinition): void => {
    // Selecting or measuring a node reaches here too, and changes nothing a definition holds.
    if (JSON.stringify(next) === JSON.stringify(definition)) {
      setDefinition(next)
      return
    }
    const now = Date.now()
    if (now - lastEdit.current > COALESCE_MS) record()
    else setHistory(({ past }) => ({ past, future: [] }))
    lastEdit.current = now
    setDefinition(next)
  }

  /** Step back to the previous version of the open definition. */
  const undo = (): void => {
    const previous = history.past.at(-1)
    if (previous === undefined) return
    setHistory({ past: history.past.slice(0, -1), future: [definition, ...history.future] })
    lastEdit.current = 0
    sync(previous)
  }

  /** Step forward to the version the last undo left. */
  const redo = (): void => {
    const [next, ...rest] = history.future
    if (next === undefined) return
    setHistory({ past: [...history.past, definition], future: rest })
    lastEdit.current = 0
    sync(next)
  }

  /**
   * Open a saved workflow.
   * @returns Whether the panel could open it; when not, the notice says why.
   */
  const select = (workflow: WorkflowRow): boolean => {
    const fault = openFault(workflow.definition)
    if (fault !== undefined) {
      setNotice(refusalText(fault, t))
      return false
    }
    open(workflow.definition)
    setSelectedId(workflow.id)
    return true
  }

  /**
   * Read the saved workflows again.
   * @param open - Which workflow to open: one ID, else the open one, else the first the panel can open; `keep` reads the
   * list without reopening anything, so unsaved edits stay.
   */
  const load = async (open?: string | 'keep'): Promise<void> => {
    setPhase('loading')
    setNotice(undefined)
    const next = await callRemote(() => remote.snapshot(), fail)
    if (next !== undefined) {
      setSnapshot(next)
      const openable = next.workflows.filter(row => openFault(row.definition) === undefined)
      const selected = open === 'keep'
        ? undefined
        : next.workflows.find(row => row.id === open)
          ?? openable.find(row => row.id === selectedId)
          ?? openable[0]
      if (selected !== undefined) select(selected)
    }
    setPhase('ready')
  }

  useEffect(() => {
    void load()
  }, [])

  /** Open a new, unsaved workflow. */
  const create = (): void => {
    setSelectedId(undefined)
    open(emptyDefinition(nextWorkflowName(snapshot.workflows)))
  }

  /** Save the open definition, creating it or replacing the selected one; failures show as the notice. */
  const persist = async (): Promise<SavedWorkflow | undefined> => {
    const result = await callRemote(
      () => selectedId === undefined ? remote.save(definition) : remote.update(selectedId, definition),
      fail,
    )
    if (result !== undefined) setSelectedId(result.workflowId)
    return result
  }

  const save = async (): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const result = await persist()
    if (result === undefined) {
      setPhase('ready')
      return
    }
    await load(result.workflowId)
    setNotice(t('notice.saved'))
  }

  /**
   * Delete a saved workflow. Deleting the open one opens another, or a new one when none is left;
   * deleting another one leaves the open workflow and its unsaved edits alone.
   */
  const remove = async (id: string): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const deleted = await callRemote(() => remote.delete(id), fail)
    if (deleted === undefined) {
      setPhase('ready')
      return
    }
    if (id === selectedId) {
      setSelectedId(undefined)
      open(emptyDefinition(nextWorkflowName(snapshot.workflows)))
      await load()
    } else {
      await load('keep')
    }
    setNotice(t('notice.deleted'))
  }

  /**
   * Load one picked file into the editor as an unsaved workflow.
   * @returns Whether the file was opened.
   */
  const importFile = async (file: File): Promise<boolean> => {
    try {
      const imported = parseImportedWorkflow(await file.text())
      const fault = openFault(imported)
      if (fault !== undefined) {
        setNotice(refusalText(fault, t))
        return false
      }
      setSelectedId(undefined)
      open({ ...imported, name: importedWorkflowName(imported.name, snapshot.workflows) })
      setNotice(t('notice.imported'))
      return true
    } catch (error: unknown) {
      setNotice(messageOf(error))
      return false
    }
  }

  return {
    snapshot,
    selectedId,
    definition,
    revision,
    phase,
    notice,
    setPhase,
    setNotice,
    fail,
    sync,
    change,
    edit,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    select,
    load,
    create,
    persist,
    save,
    remove,
    importFile,
  }
}

/**
 * A new workflow, holding only its two boundary nodes.
 *
 * They are ordinary nodes, so a new workflow could start without them; seeding them means the
 * place to declare an input is on screen from the start instead of hiding in the node library.
 * @param name - The new workflow's name.
 */
function emptyDefinition(name: string): DagWorkflowDefinition {
  return {
    name,
    nodes: [boundaryNode('inputs'), boundaryNode('outputs')],
    edges: [],
  }
}
