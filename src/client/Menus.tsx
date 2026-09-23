/** Searchable dropdown menus for switching workflows and adding nodes. */

import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconFolderCloseRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import type { Atom, AtomLibrary, TypedName } from '../shared/language.ts'
import type { NodeTypeSummary } from '../shared/types.ts'
import type { Translate } from './locale.ts'
import { filterNodeTypes, filterWorkflows, type WorkflowRow } from './model.ts'
import css from './WorkflowStudioPanel.module.css'

/** Pick a saved workflow or start a new one. */
export function WorkflowPicker({
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
  readonly t: Translate
  readonly onCreate: () => void
  readonly onSelect: (workflow: WorkflowRow) => void
}) {
  const menu = useMenu()
  const matches = filterWorkflows(workflows, menu.query)
  const rowClass = (active: boolean): string => `${css.workflowMenuRow} ${active ? css.workflowMenuRowActive : ''}`

  return (
    <div className={css.workflowPicker} ref={menu.rootRef}>
      <Tooltip label={t('workflows.switch')} side="bottom" delayMs={500}>
        <Button
          size="sm"
          variant="outline"
          icon={<IconFolderCloseRegular size={14} />}
          disabled={disabled}
          aria-label={t('workflows.switch')}
          aria-haspopup="dialog"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        />
      </Tooltip>
      {menu.open && (
        <div className={css.workflowMenu} role="dialog" aria-label={t('workflows.title')}>
          <MenuSearch menu={menu} label={t('workflows.search')} />
          <div className={css.workflowMenuList}>
            <button
              type="button"
              className={rowClass(selectedId === undefined)}
              onClick={() => { onCreate(); menu.close() }}
            >
              <IconPlusOutlineRegular size={14} />
              <span>{t('workflows.new')}</span>
              {selectedId === undefined && <IconCheckOutlineRegular size={14} />}
            </button>
            {matches.length === 0
              ? <p className={css.menuEmpty}>{t('workflows.empty')}</p>
              : matches.map(workflow => (
                  <button
                    type="button"
                    className={rowClass(selectedId === workflow.id)}
                    key={workflow.id}
                    onClick={() => { onSelect(workflow); menu.close() }}
                  >
                    <strong>{workflow.name}</strong>
                    {selectedId === workflow.id && <IconCheckOutlineRegular size={14} />}
                  </button>
                ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Pick a registered node type, or an atom from the workflow's atom folder, to add to the canvas.
 * @param atoms - The workflow's atom library; absent when it has no atom folder.
 */
export function NodeLibraryMenu({
  disabled,
  nodeTypes,
  atoms,
  t,
  onSelect,
  onSelectAtom,
}: {
  readonly disabled: boolean
  readonly nodeTypes: readonly NodeTypeSummary[]
  readonly atoms: AtomLibrary | undefined
  readonly t: Translate
  readonly onSelect: (nodeType: NodeTypeSummary) => void
  readonly onSelectAtom: (atom: Atom) => void
}) {
  const menu = useMenu()
  const matches = filterNodeTypes(nodeTypes, menu.query)
  const needle = menu.query.trim().toLocaleLowerCase()
  const found = (...values: string[]): boolean => values.some(value => value.toLocaleLowerCase().includes(needle))
  const atomMatches = [...atoms?.atoms.values() ?? []].filter(atom => found(atom.signature.name, atom.file))
  const faultMatches = atoms?.faults.filter(fault => found(fault.file)) ?? []

  return (
    <div className={css.nodePicker} ref={menu.rootRef}>
      <Button
        size="sm"
        variant="outline"
        icon={<IconPlusOutlineRegular size={14} />}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <span>{t('nodes.add')}</span>
        <IconChevronDownOutlineRegular size={12} />
      </Button>
      {menu.open && (
        <div className={css.nodeMenu} role="dialog" aria-label={t('nodes.title')}>
          <MenuSearch menu={menu} label={t('nodes.search')} />
          <div className={css.nodeMenuList}>
            {matches.length === 0
              ? <p className={css.menuEmpty}>{t('nodes.empty')}</p>
              : matches.map(node => (
                  <button
                    type="button"
                    className={css.nodeType}
                    key={node.type}
                    onClick={() => { onSelect(node); menu.close() }}
                  >
                    <span className={css.nodeTypeTitle}>
                      <strong>{node.label}</strong>
                      <code>{node.type}</code>
                    </span>
                    <span>{node.description}</span>
                    <small>{t('nodes.source')}: {node.sourcePlugin}</small>
                  </button>
                ))}
            {atoms !== undefined && <p className={css.menuGroup}>{t('atoms.group')}</p>}
            {atomMatches.map(atom => (
              <button
                type="button"
                className={css.nodeType}
                key={atom.file}
                onClick={() => { onSelectAtom(atom); menu.close() }}
              >
                <span className={css.nodeTypeTitle}>
                  <strong>{atom.signature.name}</strong>
                  <code>{atom.file}</code>
                </span>
                <span>({signatureText(atom.signature.parameters)}) ({signatureText(atom.signature.results)})</span>
              </button>
            ))}
            {faultMatches.map(fault => (
              <button type="button" className={css.nodeType} key={fault.file} disabled>
                <span className={css.nodeTypeTitle}><code>{fault.file}</code></span>
                <small>{t(`atoms.fault.${fault.fault}`)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type Menu = ReturnType<typeof useMenu>

/** Open state and search query of a menu; an open menu focuses its search and closes on Escape or an outside click. */
function useMenu() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) setOpen(false)
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
  }, [open])

  return {
    open,
    query,
    setQuery,
    rootRef,
    searchRef,
    toggle: (): void => {
      setQuery('')
      setOpen(value => !value)
    },
    close: (): void => {
      setOpen(false)
      setQuery('')
    },
  }
}

function MenuSearch({ menu, label }: { readonly menu: Menu; readonly label: string }) {
  return (
    <label className={css.menuSearch}>
      <IconSearchOutlineRegular size={14} />
      <input
        ref={menu.searchRef}
        aria-label={label}
        placeholder={label}
        value={menu.query}
        onChange={event => { menu.setQuery(event.currentTarget.value) }}
      />
    </label>
  )
}

/** A signature's parameters or results as `name type` pairs. */
function signatureText(names: readonly TypedName[]): string {
  return names.map(({ name, type }) => `${name} ${type}`).join(', ')
}
