/** Side panel for a code workflow's atom folder: the folder itself, and the atoms in it that the canvas can call. */

import {
  Button,
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import {
  CODE_ATOM_TYPE,
  atomOf,
  typeName,
  type Atom,
  type AtomFault,
  type AtomLibrary,
  type AtomSyntax,
  type Language,
  type TypedName,
} from '../shared/language.ts'
import type { DagWorkflowDefinition } from '../shared/types.ts'
import { AtomFolderDialog } from './AtomFolderDialog.tsx'
import type { Translate } from './locale.ts'
import type { WorkflowStudioRemoteNamespace } from './remote.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * The atom folder of a workflow whose language reads atoms.
 * @param definition - The workflow being edited.
 * @param language - Its language.
 * @param syntax - How that language reads an atom folder.
 * @param library - The atoms read from the folder; undefined while it is read, or when there is no folder.
 * @param remote - The `workflowStudio` Remote, which lists Host folders for the folder dialog.
 * @param t - Translate.
 * @param onChange - Receives the workflow with its atom folder changed.
 * @param onAdd - Places a node calling the atom on the canvas.
 * @param onReload - Reads the folder again.
 * @param onClose - Hides the panel.
 */
export function AtomsPanel({ definition, language, syntax, library, remote, t, onChange, onAdd, onReload, onClose }: {
  readonly definition: DagWorkflowDefinition
  readonly language: Language
  readonly syntax: AtomSyntax
  readonly library: AtomLibrary | undefined
  readonly remote: WorkflowStudioRemoteNamespace
  readonly t: Translate
  readonly onChange: (definition: DagWorkflowDefinition) => void
  readonly onAdd: (atom: Atom) => void
  readonly onReload: () => void
  readonly onClose: () => void
}) {
  const [folderPrompt, setFolderPrompt] = useState(false)
  const [query, setQuery] = useState('')
  const folder = definition.atomFolder
  const setFolder = (next: string | undefined): void => {
    const { atomFolder: _previous, ...rest } = definition
    onChange(next === undefined ? rest : { ...rest, atomFolder: next })
  }
  const needle = query.trim().toLocaleLowerCase()
  const atoms = [...library?.atoms.values() ?? []]
    .filter(atom => [atom.signature.name, atom.file].some(value => value.toLocaleLowerCase().includes(needle)))
  // Nodes whose atom the folder no longer holds keep their ports, but the workflow cannot be written until they go.
  const missing = library === undefined
    ? []
    : definition.nodes.filter(node => node.type === CODE_ATOM_TYPE && !library.atoms.has(atomOf(node.config)))

  return (
    <aside className={css.atomsPanel} aria-label={t('atoms.panel')}>
      <div className={css.detailsHeader}>
        <h2>{t('atoms.panel')}</h2>
        {folder !== undefined && (
          <button type="button" className={css.detailsClose} aria-label={t('atoms.reload')} title={t('atoms.reload')} onClick={onReload}>
            <IconRefreshOutlineRegular size={14} />
          </button>
        )}
        <button type="button" className={css.detailsClose} aria-label={t('atoms.close')} title={t('atoms.close')} onClick={onClose}>
          <IconCloseOutlineRegular size={14} />
        </button>
      </div>
      <div className={css.atomsFolder}>
        <code title={folder}>{folder ?? t('atoms.noFolder')}</code>
        {library !== undefined && (
          <small><code>{syntax.types}</code> {t(library.types ? 'atoms.typesPresent' : 'atoms.typesAbsent')}</small>
        )}
        <div className={css.settingsActions}>
          <Button size="sm" variant="outline" onClick={() => { setFolderPrompt(true) }}>
            {t(folder === undefined ? 'atoms.choose' : 'atoms.change')}
          </Button>
          {folder !== undefined && (
            <Button size="sm" variant="outline" onClick={() => { setFolder(undefined) }}>{t('atoms.clear')}</Button>
          )}
        </div>
      </div>
      {folder !== undefined && (
        <div className={css.atomsContent}>
          {library === undefined
            ? <small>{t('atoms.loading')}</small>
            : (
              <>
                <label className={css.menuSearch}>
                  <IconSearchOutlineRegular size={14} />
                  <input
                    aria-label={t('atoms.search')}
                    placeholder={t('atoms.search')}
                    value={query}
                    onChange={(event) => { setQuery(event.currentTarget.value) }}
                  />
                </label>
                {library.atoms.size === 0 && <small>{t('atoms.empty')}</small>}
                <ul className={css.atomList}>
                  {atoms.map(atom => (
                    <li key={atom.file}>
                      <button type="button" title={t('atoms.add')} onClick={() => { onAdd(atom) }}>
                        <span className={css.nodeTypeTitle}>
                          <strong>{atom.signature.name}</strong>
                          <code>{atom.file}</code>
                        </span>
                        <code className={css.atomSignature}>
                          ({signatureText(atom.signature.parameters, language)})
                          {atom.signature.results.length > 0 && ` → (${signatureText(atom.signature.results, language)})`}
                        </code>
                      </button>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 && (
                  <section className={css.atomProblems}>
                    <h3>{t('atoms.missing')}</h3>
                    <ul>
                      {missing.map(node => (
                        <li key={node.id}><strong>{node.label ?? node.id}</strong> <code>{atomOf(node.config)}</code></li>
                      ))}
                    </ul>
                  </section>
                )}
                {library.faults.length > 0 && (
                  <section className={css.atomProblems}>
                    <h3>{t('atoms.faults')}</h3>
                    <ul>
                      {library.faults.map(fault => (
                        <li key={fault.file}><code>{fault.file}</code> {faultText(fault, t)}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
        </div>
      )}
      {folderPrompt && (
        <AtomFolderDialog
          folder={folder}
          syntax={syntax}
          remote={remote}
          t={t}
          onCancel={() => { setFolderPrompt(false) }}
          onChoose={(next) => {
            setFolderPrompt(false)
            setFolder(next)
          }}
        />
      )}
    </aside>
  )
}

/** A signature's parameters or results as `name type` pairs, in the language's type names. */
function signatureText(names: readonly TypedName[], language: Language): string {
  return names.map(({ name, type }) => `${name} ${typeName(language, type)}`).join(', ')
}

function faultText(fault: AtomFault, t: Translate): string {
  const text = t(`atoms.fault.${fault.fault}`)
  return fault.fault === 'several-exported-functions' ? `${text} ${fault.names.join(', ')}` : text
}
