/** Import and export of one workflow definition as a JSON file. */

import type { DagWorkflowDefinition } from '../shared/types.ts'
import { workflowSlug } from '../shared/slug.ts'
import { workflowDefinitionSchema } from '../shared/workflow-schema.ts'
import { formatEditorDefinition } from './model.ts'

/** Suffix that marks an exported definition, kept out of the workflow name. */
const EXPORT_SUFFIX = '.workflow.json'

/**
 * Name of the file one definition exports to.
 * @param definition - Definition being exported.
 * @returns The file name, derived from the workflow name like its record file.
 */
export function workflowFileName(definition: DagWorkflowDefinition): string {
  return `${workflowSlug(definition.name)}${EXPORT_SUFFIX}`
}

/**
 * Parse an imported workflow file.
 *
 * Accepts both an exported definition and a record document copied straight out of the storage directory,
 * which wraps the same definition in the storage backend's `{ version, record }` envelope.
 * @param source - File content.
 * @returns The definition.
 * @throws When the content is not JSON or not a complete definition.
 */
export function parseImportedWorkflow(source: string): DagWorkflowDefinition {
  const content = JSON.parse(source) as unknown
  const unwrapped = isRecordDocument(content) ? content.record : content
  return workflowDefinitionSchema.parse(unwrapped)
}

/**
 * Give an imported definition a name no saved workflow already uses.
 *
 * An import never replaces a saved workflow: saving reuses the ID of a same-named one, so an import
 * that kept a taken name would overwrite it on the next save.
 * @param name - Name carried by the imported file.
 * @param workflows - Saved workflows.
 * @returns The name itself when free, otherwise it with the first free ` (n)` suffix.
 */
export function importedWorkflowName(
  name: string,
  workflows: readonly { readonly name: string }[],
): string {
  const taken = new Set(workflows.map(workflow => workflow.name))
  if (!taken.has(name)) return name
  for (let index = 2; ; index += 1) {
    const candidate = `${name} (${index})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Hand one definition to the browser as a downloaded file.
 * @param definition - Definition to export.
 */
export function downloadWorkflow(definition: DagWorkflowDefinition): void {
  const url = URL.createObjectURL(new Blob(
    [formatEditorDefinition(definition)],
    { type: 'application/json' },
  ))
  const link = document.createElement('a')
  link.href = url
  link.download = workflowFileName(definition)
  document.body.append(link)
  link.click()
  link.remove()
  // The download reads the object URL after click() returns, so the handle is released on the next task.
  setTimeout(() => { URL.revokeObjectURL(url) })
}

/** Whether a parsed file is a storage record document rather than a bare definition. */
function isRecordDocument(content: unknown): content is { record: unknown } {
  return typeof content === 'object' && content !== null
    && typeof (content as { version?: unknown }).version === 'number'
    && 'record' in content
}
