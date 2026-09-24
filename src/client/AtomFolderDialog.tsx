/** Dialog that browses Host folders one level at a time and picks a code workflow's atom folder. */

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { isAtomFile, type AtomSyntax } from '../shared/language.ts'
import type { FolderListing } from '../shared/types.ts'
import { folderListingSchema } from '../shared/workflow-schema.ts'
import type { Translate } from './locale.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Browse from the current atom folder, or the Host user's home folder when there is none.
 * @param folder - The workflow's current atom folder.
 * @param syntax - How the workflow's language reads an atom folder, so each folder shows how many atom files it holds.
 * @param remote - The `workflowStudio` Remote, which lists Host folders.
 * @param t - Translate.
 * @param onCancel - Closes the dialog without changing the folder.
 * @param onChoose - Receives the chosen folder's absolute path.
 */
export function AtomFolderDialog({ folder, syntax, remote, t, onCancel, onChoose }: {
  readonly folder: string | undefined
  readonly syntax: AtomSyntax
  readonly remote: WorkflowStudioRemoteNamespace
  readonly t: Translate
  readonly onCancel: () => void
  readonly onChoose: (folder: string) => void
}) {
  const [path, setPath] = useState(folder ?? '')
  const [typed, setTyped] = useState(folder ?? '')
  const [listing, setListing] = useState<FolderListing>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let current = true
    setError(undefined)
    void callRemote(() => remote.folders(path), source => folderListingSchema.parse(JSON.parse(source)), (message) => {
      if (current) setError(message)
    }).then((next) => {
      if (!current || next === undefined) return
      setListing(next)
      setTyped(next.path)
    })
    return () => { current = false }
  }, [path])

  const atoms = listing?.files.filter(file => isAtomFile(file, syntax)).length ?? 0
  return (
    <Modal
      open
      title={t('atoms.title')}
      description={t('atoms.description')}
      closeLabel={t('run.close')}
      onClose={onCancel}
      footer={(
        <div className={css.runActions}>
          <Button size="sm" variant="outline" onClick={onCancel}>{t('run.cancel')}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={listing === undefined || error !== undefined}
            onClick={() => { if (listing !== undefined) onChoose(listing.path) }}
          >
            {t('atoms.use')}
          </Button>
        </div>
      )}
    >
      <div className={css.folderBrowser}>
        <form onSubmit={(event) => { event.preventDefault(); setPath(typed) }}>
          <input aria-label={t('atoms.path')} value={typed} onChange={(event) => { setTyped(event.currentTarget.value) }} />
        </form>
        {error !== undefined && <p className={css.notice} role="alert">{error}</p>}
        {listing !== undefined && (
          <>
            <small>{atoms} {t('atoms.files')} ({syntax.extension})</small>
            <ul>
              {[
                ...listing.parent === undefined ? [] : [{ name: '..', path: listing.parent }],
                ...listing.folders.map(({ name, path: child }) => ({ name: `${name}/`, path: child })),
              ].map(entry => (
                <li key={entry.path}>
                  <button type="button" onClick={() => { setPath(entry.path) }}>{entry.name}</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
