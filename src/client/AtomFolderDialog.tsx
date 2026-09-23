/** Dialog that browses Host folders one level at a time and picks a code workflow's atom folder. */

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import type { FolderListing } from '../shared/types.ts'
import { folderListingSchema } from '../shared/workflow-schema.ts'
import type { Translate } from './locale.ts'
import { callRemote, type WorkflowStudioRemoteNamespace } from './remote.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Browse from the current atom folder, or the Host user's home folder when there is none.
 * @param folder - The workflow's current atom folder.
 * @param extension - Extension of an atom file, so each folder shows how many atoms it holds.
 * @param remote - The `workflowStudio` Remote, which lists Host folders.
 * @param t - Translate.
 * @param onCancel - Closes the dialog without changing the folder.
 * @param onChoose - Receives the chosen folder's absolute path, or undefined to clear it.
 */
export function AtomFolderDialog({ folder, extension, remote, t, onCancel, onChoose }: {
  readonly folder: string | undefined
  readonly extension: string
  readonly remote: WorkflowStudioRemoteNamespace
  readonly t: Translate
  readonly onCancel: () => void
  readonly onChoose: (folder: string | undefined) => void
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

  const atoms = listing?.files.filter(file => file.endsWith(extension) && !file.endsWith(`_test${extension}`)).length ?? 0
  return (
    <Modal
      open
      title={t('atoms.title')}
      description={t('atoms.description')}
      closeLabel={t('run.close')}
      onClose={onCancel}
      footer={(
        <div className={css.runActions}>
          {folder !== undefined && (
            <Button size="sm" variant="outline" onClick={() => { onChoose(undefined) }}>{t('atoms.clear')}</Button>
          )}
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
            <small>{atoms} {t('atoms.files')} ({extension})</small>
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
