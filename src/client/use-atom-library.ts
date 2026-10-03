/** The atoms of the open code workflow's atom folder, read from the Host. */

import { useEffect, useState } from 'react'
import { atomLibrary, languageOf, type AtomLibrary } from '../shared/language.ts'
import type { DagWorkflowDefinition } from '../shared/types.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'

/**
 * Read the workflow's atom folder whenever the folder or the language changes, or when asked to.
 * @param remote - The `workflowStudio` Remote.
 * @param definition - The open workflow.
 * @param onError - Receives a failed read; `failureText` words it.
 * @returns The atoms, undefined while the folder is being read or when the workflow has no atom folder, and `reload`,
 * which reads the folder again so edited files are picked up.
 */
export function useAtomLibrary(
  remote: WorkflowStudioRemoteNamespace,
  definition: DagWorkflowDefinition,
  onError: (failure: unknown) => void,
): { readonly library: AtomLibrary | undefined; readonly reload: () => void } {
  const [library, setLibrary] = useState<AtomLibrary>()
  const [reads, setReads] = useState(0)
  const { atomFolder: folder, language } = definition
  const syntax = languageOf(definition).functions?.atoms

  useEffect(() => {
    // The atoms panel shows the folder as being read until its atoms arrive.
    setLibrary(undefined)
    if (folder === undefined || syntax === undefined || language === undefined) return undefined
    let current = true
    void callRemote(() => remote.atomFiles(folder, language), onError)
      .then((files) => { if (current && files !== undefined) setLibrary(atomLibrary(folder, files, syntax)) })
    return () => { current = false }
  }, [folder, language, reads])

  return { library, reload: () => { setReads(value => value + 1) } }
}
