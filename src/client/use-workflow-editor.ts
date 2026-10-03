/** The saved workflows, the workflow open in the editor, and the actions that load, save, delete, and import them. */

import { useEffect, useState } from 'react'
import { messageOf } from '../shared/errors.ts'
import { CODE_LANGUAGES, languageOf } from '../shared/language.ts'
import type { DagWorkflowDefinition, SavedWorkflow, WorkflowKind, WorkflowStudioSnapshot } from '../shared/types.ts'
import { failureText } from './failure-text.ts'
import type { Translate } from './locale.ts'
import { nextWorkflowName, openFault, type WorkflowRow } from './model.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import { importedWorkflowName, parseImportedWorkflow } from './transfer.ts'
import { boundaryNode } from './workflow-ports.ts'

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
  const [definition, setDefinition] = useState<DagWorkflowDefinition>(() => emptyDefinition('workflow-1', 'run'))
  // Incremented when the canvas must discard its local graph and reload `definition`.
  const [revision, setRevision] = useState(0)
  const [phase, setPhase] = useState<EditorPhase>('loading')
  const [notice, setNotice] = useState<string>()

  /** Show a failed Remote call as the notice, a refusal worded in the active locale. */
  const fail = (failure: unknown): void => { setNotice(failureText(failure, t)) }

  /** Replace the open definition and make the canvas reload it. */
  const replace = (next: DagWorkflowDefinition): void => {
    setDefinition(next)
    setRevision(value => value + 1)
    setNotice(undefined)
  }

  /** The definition, or an error naming why the panel cannot edit it. */
  const editable = (next: DagWorkflowDefinition): DagWorkflowDefinition => {
    const fault = openFault(next)
    if (fault !== undefined) throw new Error(`${t(fault.key)} ${fault.detail}`)
    return next
  }

  const select = (workflow: WorkflowRow): void => {
    try {
      replace(editable(workflow.definition))
      setSelectedId(workflow.id)
    } catch (error: unknown) {
      setNotice(messageOf(error))
    }
  }

  /** Read the saved workflows again and open `preferredId`, else the open one, else the first. */
  const load = async (preferredId?: string): Promise<void> => {
    setPhase('loading')
    setNotice(undefined)
    const next = await callRemote(() => remote.snapshot(), fail)
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

  /** Open a new, unsaved workflow of one kind. */
  const create = (kind: WorkflowKind): void => {
    setSelectedId(undefined)
    replace(emptyDefinition(nextWorkflowName(snapshot.workflows, kind), kind))
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
    // Saving a workflow with an atom folder also writes its function into that folder, in a file named after its ID.
    const syntax = languageOf(definition).functions?.atoms
    const written = definition.atomFolder === undefined || syntax === undefined
      ? undefined
      : `${result.workflowId}${syntax.outputSuffix}`
    await load(result.workflowId)
    const saved = written === undefined
      ? t('notice.saved')
      : result.sourceError === undefined
        ? `${t('notice.savedFile')} ${written}`
        : `${t('notice.savedNoFile')} ${result.sourceError}`
    setNotice([saved, ...(result.embedderErrors ?? []).map(({ name, error }) => `${t('notice.embedderNoFile')} ${name}: ${error}`)].join(' '))
  }

  /** Delete a saved workflow, then open another, or a new one of the same kind when none is left. */
  const remove = async (id: string): Promise<void> => {
    setPhase('saving')
    setNotice(undefined)
    const deleted = await callRemote(() => remote.delete(id), fail)
    if (deleted === undefined) {
      setPhase('ready')
      return
    }
    setSelectedId(undefined)
    replace(emptyDefinition(nextWorkflowName(snapshot.workflows, definition.kind), definition.kind))
    await load()
    setNotice(t('notice.deleted'))
  }

  /**
   * Load one picked file into the editor as an unsaved workflow.
   * @returns Whether the file was opened.
   */
  const importFile = async (file: File): Promise<boolean> => {
    try {
      const imported = editable(parseImportedWorkflow(await file.text()))
      setSelectedId(undefined)
      replace({ ...imported, name: importedWorkflowName(imported.name, snapshot.workflows) })
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
    replace,
    /** Change the open definition in place, as the canvas and the name field do, without reloading the canvas. */
    edit: setDefinition,
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
 * @param kind - The new workflow's kind; a code workflow starts in the first code language.
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
