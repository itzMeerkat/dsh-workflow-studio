/** The node card both graphs render: identity, ports, inline controls, and displayed run outputs. */

import { Handle, NodeResizeControl, Position, ResizeControlVariant, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { createContext, useContext, useEffect, useState } from 'react'
import { DIAGNOSTIC_SEVERITY } from '../shared/analysis.ts'
import type { WorkflowDiagnostic } from '../shared/analysis.ts'
import type { NodeControlDefinition, PortDefinition } from '../shared/types.ts'
import { EXEC_RUN_PIN } from '../shared/graph.ts'
import { typeName, type Language } from '../shared/language.ts'
import { SUBWORKFLOW_TYPE, subworkflowOf } from '../shared/subworkflow.ts'
import { SWITCH_TYPE, invalidCase, switchCases } from '../shared/switch.ts'
import type { WorkflowId } from '../shared/types.ts'
import { diagnosticDetails } from './DiagnosticsView.tsx'
import { handleId, nodeInputPorts, nodeOutputPins, nodeOutputPorts, type WorkflowFlowNode, type WorkflowNodeData } from './graph-model.ts'
import type { Translate } from './locale.ts'
import type { WorkflowRow } from './model.ts'
import css from './WorkflowStudioPanel.module.css'

/**
 * Which graph a card is drawn in.
 *
 * `data` is the editable canvas, where every port and pin is its own connectable handle.
 * `execution` is the read-only dependency graph, where whole nodes are joined and only a
 * branching pin needs a handle of its own.
 */
export type NodeCardGraph = 'data' | 'execution'

/** What the cards React Flow renders need from the view around them. */
export interface NodeCardActions {
  readonly t: Translate
  /** The workflow's language, which names the port types. */
  readonly language: Language
  /** Set when the card may edit configuration; absent in a read-only graph. */
  readonly updateConfig?: (nodeId: string, name: string, value: unknown) => void
  /** Set when a subworkflow card may change the workflow it links to; absent in a read-only graph. */
  readonly linkWorkflow?: {
    /** The saved workflows the edited one may embed. */
    readonly choices: readonly WorkflowRow[]
    readonly link: (nodeId: string, workflow: WorkflowId) => void
  }
  /**
   * Set when a switch card may edit its cases; absent in a read-only graph.
   * @param renamed - The case whose text changed, so the edges on its pin follow it.
   */
  readonly editCases?: (nodeId: string, cases: readonly string[], renamed?: { readonly from: string; readonly to: string }) => void
}

/** Provides {@link NodeCardActions} to the cards React Flow renders. */
export const NodeCardContext = createContext<NodeCardActions | undefined>(undefined)

/** Render one workflow node on the editable canvas. */
export function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  return <NodeCard data={data} graph="data" selected={selected} />
}

/**
 * Render one workflow node.
 * @param data - The node's definition, catalog entry, and latest run record.
 * @param graph - Which graph the card is drawn in.
 * @param selected - Whether the canvas has the node selected.
 * @param branchPins - Execution output pins that carry a handle of their own.
 */
export function NodeCard({
  data,
  graph,
  selected = false,
  branchPins = [],
}: {
  readonly data: WorkflowNodeData
  readonly graph: NodeCardGraph
  readonly selected?: boolean
  readonly branchPins?: readonly string[]
}) {
  const actions = useContext(NodeCardContext)
  const pins = nodeOutputPins(data)
  const updateNodeInternals = useUpdateNodeInternals()
  // A switch's pins follow its cases; React Flow measures a card's handles again only when told they changed.
  useEffect(() => { updateNodeInternals(data.definition.id) }, [pins.join('\u0000')])
  if (actions === undefined) throw new Error('Workflow node card rendered outside its view')
  const { t, language, updateConfig, linkWorkflow, editCases } = actions
  const inputs = nodeInputPorts(data)
  const outputs = nodeOutputPorts(data)
  const controls = data.catalog?.controls ?? []
  const runOutputs = displayedOutputs(data)
  const connectable = graph === 'data'
  const title = data.definition.label ?? data.catalog?.label ?? data.definition.type
  return (
    <article className={cardClass(graph, selected)}>
      {graph === 'data' && <CardResizer />}
      {graph === 'execution' && (
        <Handle id="dependency" type="target" position={Position.Left} isConnectable={false} />
      )}
      <div className={css.nodeHeader}>
        <strong title={title}>{title}</strong>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
        {data.diagnostics !== undefined && <DiagnosticBadge diagnostics={data.diagnostics} t={t} />}
      </div>
      <div className={css.nodeMeta}>
        <code title={data.definition.type}>{data.definition.type}</code>
        {data.catalog !== undefined && <span title={data.catalog.sourcePlugin}>{data.catalog.sourcePlugin}</span>}
      </div>
      <div className={css.execPins}>
        <ExecPin pin={EXEC_RUN_PIN} side="input" connectable={connectable} />
        <div className={css.execPinGroup}>
          {pins.map(pin => (
            <ExecPin
              key={pin}
              pin={pin}
              side="output"
              connectable={connectable}
              branch={branchPins.includes(pin)}
            />
          ))}
        </div>
      </div>
      <div className={css.ports}>
        <div>{inputs.map(port => <PortRow key={port.name} port={port} language={language} side="input" connectable={connectable} />)}</div>
        <div>{outputs.map(port => <PortRow key={port.name} port={port} language={language} side="output" connectable={connectable} />)}</div>
      </div>
      {data.definition.type === SUBWORKFLOW_TYPE && linkWorkflow !== undefined && (
        <div className={css.nodeControls}>
          <WorkflowLink
            linked={subworkflowOf(data.definition.config)}
            choices={linkWorkflow.choices}
            t={t}
            onLink={(workflow) => { linkWorkflow.link(data.definition.id, workflow) }}
          />
        </div>
      )}
      {data.definition.type === SWITCH_TYPE && editCases !== undefined && (
        <div className={css.nodeControls}>
          <SwitchCases
            cases={switchCases(data.definition.config)}
            t={t}
            onChange={(cases, renamed) => { editCases(data.definition.id, cases, renamed) }}
          />
        </div>
      )}
      {controls.length > 0 && (
        <div className={css.nodeControls}>
          {controls.map(control => (
            <NodeControl
              key={control.name}
              control={control}
              value={data.definition.config[control.name] ?? control.defaultValue}
              {...(updateConfig === undefined
                ? { readOnly: true as const }
                : {
                  onChange: (value: unknown) => { updateConfig(data.definition.id, control.name, value) },
                })}
            />
          ))}
        </div>
      )}
      <CardRunValues title={t('node.output')} values={runOutputs} />
      {graph === 'execution' && (
        <Handle id="dependency" type="source" position={Position.Right} isConnectable={false} />
      )}
    </article>
  )
}

/**
 * The class of a card's frame. On the editable canvas the card fills the width its node is given, which its
 * author can change; the execution-order view lays cards out at the stylesheet's width.
 * @param graph - Which graph the card is drawn in.
 * @param selected - Whether the canvas has the node selected.
 */
export function cardClass(graph: NodeCardGraph, selected: boolean): string {
  return [css.canvasNode, graph === 'data' && css.canvasNodeResizable, selected && css.canvasNodeSelected]
    .filter(Boolean).join(' ')
}

/** Narrowest and widest a card can be dragged, in pixels. */
const CARD_WIDTH_RANGE = { min: 160, max: 640 } as const

/** The grip on a card's right edge that sets its width; the height keeps following the content. */
export function CardResizer() {
  return (
    <NodeResizeControl
      // The stylesheet defines the class; the module typing only cannot promise it.
      className={css.cardResizer!}
      variant={ResizeControlVariant.Line}
      position="right"
      resizeDirection="horizontal"
      minWidth={CARD_WIDTH_RANGE.min}
      maxWidth={CARD_WIDTH_RANGE.max}
    />
  )
}

/** One value a run produced, as a card shows it. */
export interface CardRunValue {
  readonly name: string
  readonly value: unknown
  /** How to print it; a string prints as itself and anything else as JSON when this is absent. */
  readonly display?: 'value' | 'json'
}

/**
 * What a run produced, as every card shows it.
 *
 * Both cards report a run the same way, so the section is one component: a node card lists the
 * output ports it declared, and the workflow's output card lists what the run returned.
 * @param title - The section heading.
 * @param values - The values to list, in the order they should appear.
 * @returns The section, or nothing when the run produced none.
 */
export function CardRunValues({ title, values }: {
  readonly title: string
  readonly values: readonly CardRunValue[]
}) {
  if (values.length === 0) return null
  return (
    <div className={css.nodeOutputs}>
      <span className={css.nodeSection}>{title}</span>
      {values.map(({ name, value, display }) => (
        <div key={name} className={css.nodeOutput}>
          <span title={name}>{name}</span>
          <output>{formatOutput(value, display ?? (typeof value === 'string' ? 'value' : 'json'))}</output>
        </div>
      ))}
    </div>
  )
}

/** The output ports a run produced a displayable value for, in port order. */
function displayedOutputs(data: WorkflowNodeData): readonly CardRunValue[] {
  const produced = data.runRecord?.outputs
  if (produced === undefined) return []
  return nodeOutputPorts(data)
    .filter(port => port.display !== undefined && Object.hasOwn(produced, port.name))
    .map(port => ({ name: port.name, value: produced[port.name], display: port.display ?? 'value' }))
}

function ExecPin({ pin, side, connectable, branch = false }: {
  readonly pin: string
  readonly side: 'input' | 'output'
  readonly connectable: boolean
  readonly branch?: boolean
}) {
  const isInput = side === 'input'
  return (
    <div className={`${css.execPin} ${isInput ? css.execPinInput : css.execPinOutput}`} data-pin={pin}>
      <Handle
        type={isInput ? 'target' : 'source'}
        position={isInput ? Position.Left : Position.Right}
        id={handleId({ kind: 'exec', name: pin })}
        isConnectable={connectable}
      />
      {branch && (
        <Handle
          id={`branch:${pin}`}
          className={css.execBranchHandle}
          type="source"
          position={Position.Right}
          isConnectable={false}
        />
      )}
      <span>{pin}</span>
    </div>
  )
}

function PortRow({ port, language, side, connectable }: {
  readonly port: PortDefinition
  readonly language: Language
  readonly side: 'input' | 'output'
  readonly connectable: boolean
}) {
  const isInput = side === 'input'
  const type = typeName(language, port.type)
  // The row cuts a long name or type short, so its tooltip carries both in full.
  const title = [`${port.name} ${type}`, ...port.description === undefined ? [] : [port.description]].join('\n')
  return (
    <div className={`${css.port} ${isInput ? css.portInput : css.portOutput}`} title={title}>
      <Handle
        type={isInput ? 'target' : 'source'}
        position={isInput ? Position.Left : Position.Right}
        id={handleId({ kind: 'data', name: port.name })}
        isConnectable={connectable}
      />
      <span>{port.name}</span>
      {isInput && port.required !== false && <b className={css.requiredPort}>*</b>}
      <small>{type}</small>
    </div>
  )
}

/**
 * The workflow a subworkflow node calls. A link to a workflow the edited one may not embed, or to none yet,
 * stays listed as it is until another is chosen.
 */
function WorkflowLink({ linked, choices, t, onLink }: {
  readonly linked: WorkflowId
  readonly choices: readonly WorkflowRow[]
  readonly t: Translate
  readonly onLink: (workflow: WorkflowId) => void
}) {
  const listed = choices.some(choice => choice.id === linked)
  return (
    <label className={`${css.nodeControl} nodrag`}>
      <span>{t('node.workflow')}</span>
      <select
        className="nowheel"
        value={linked}
        onChange={(event) => {
          const choice = choices.find(item => item.id === event.currentTarget.value)
          if (choice !== undefined) onLink(choice.id)
        }}
      >
        {!listed && <option value={linked} disabled>{linked === '' ? t('node.chooseWorkflow') : linked}</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </select>
    </label>
  )
}

/** A switch's cases, each the name of the execution pin it fires. */
function SwitchCases({ cases, t, onChange }: {
  readonly cases: readonly string[]
  readonly t: Translate
  readonly onChange: (cases: readonly string[], renamed?: { readonly from: string; readonly to: string }) => void
}) {
  const fresh = (): string => {
    let index = cases.length + 1
    while (cases.includes(`case${index}`)) index += 1
    return `case${index}`
  }
  return (
    <div className={`${css.switchCases} nodrag`}>
      <span>{t('node.cases')}</span>
      {cases.map((item, index) => (
        <div key={item} className={css.switchCase}>
          <CaseInput
            value={item}
            others={cases.filter((_, position) => position !== index)}
            t={t}
            onCommit={(next) => { onChange(cases.map(value => value === item ? next : value), { from: item, to: next }) }}
          />
          <button
            type="button"
            aria-label={t('node.removeCase')}
            title={t('node.removeCase')}
            onClick={() => { onChange(cases.filter(value => value !== item)) }}
          >
            <IconCloseOutlineRegular size={10} />
          </button>
        </div>
      ))}
      <button type="button" className={css.addCase} onClick={() => { onChange([...cases, fresh()]) }}>{t('node.addCase')}</button>
    </div>
  )
}

/** One case's text, committed on blur or Enter; text that would not name a distinct pin is refused and restored. */
function CaseInput({ value, others, t, onCommit }: {
  readonly value: string
  readonly others: readonly string[]
  readonly t: Translate
  readonly onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const invalid = invalidCase([...others, draft]) !== undefined
  const commit = (): void => {
    if (invalid) setDraft(value)
    else if (draft !== value) onCommit(draft)
  }
  return (
    <input
      type="text"
      value={draft}
      aria-label={t('node.case')}
      aria-invalid={invalid}
      title={invalid ? t('node.caseInvalid') : undefined}
      onChange={(event) => { setDraft(event.currentTarget.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    />
  )
}

/** One inline control; `readOnly` shows the configured value in a graph that cannot edit it. */
type NodeControlProps = {
  readonly control: NodeControlDefinition
  readonly value: unknown
} & ({ readonly onChange: (value: unknown) => void; readonly readOnly?: undefined }
  | { readonly readOnly: true; readonly onChange?: undefined })

function NodeControl({ control, value, onChange, readOnly }: NodeControlProps) {
  const disabled = readOnly === true
  const commit = (next: unknown): void => { onChange?.(next) }
  switch (control.kind) {
    case 'boolean':
      return (
        <label className={`${css.nodeControl} nodrag`}>
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={event => { commit(event.currentTarget.checked) }}
          />
          <span>{control.label}</span>
        </label>
      )
    case 'select':
      return (
        <label className={`${css.nodeControl} nodrag`}>
          <span>{control.label}</span>
          <select
            className="nowheel"
            value={typeof value === 'string' ? value : control.defaultValue}
            disabled={disabled}
            onChange={event => { commit(event.currentTarget.value) }}
          >
            {control.options.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )
    case 'number':
      return (
        <label className={`${css.nodeControl} nodrag`}>
          <span>{control.label}</span>
          <input
            className="nowheel"
            type="number"
            value={typeof value === 'number' ? value : control.defaultValue}
            disabled={disabled}
            {...(control.min === undefined ? {} : { min: control.min })}
            {...(control.max === undefined ? {} : { max: control.max })}
            {...(control.step === undefined ? {} : { step: control.step })}
            onWheel={(event) => {
              // The field takes a typed number; wheeling over the canvas must not edit it.
              event.currentTarget.blur()
            }}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isFinite(next)) commit(next)
            }}
          />
        </label>
      )
    case 'text':
      return (
        <label className={`${css.nodeControl} nodrag`}>
          <span>{control.label}</span>
          <input
            className="nowheel"
            type="text"
            value={typeof value === 'string' ? value : control.defaultValue}
            disabled={disabled}
            {...(control.placeholder === undefined ? {} : { placeholder: control.placeholder })}
            onChange={event => { commit(event.currentTarget.value) }}
          />
        </label>
      )
    case 'textarea':
      return (
        <label className={`${css.nodeControl} ${css.nodeControlBlock} nodrag`}>
          <span>{control.label}</span>
          <textarea
            className="nowheel"
            value={typeof value === 'string' ? value : control.defaultValue}
            rows={control.rows ?? DEFAULT_TEXTAREA_ROWS}
            spellCheck={false}
            disabled={disabled}
            {...(control.placeholder === undefined ? {} : { placeholder: control.placeholder })}
            onChange={event => { commit(event.currentTarget.value) }}
          />
        </label>
      )
    default:
      return assertNever(control)
  }
}

/** Visible rows of a `textarea` control that does not ask for a height. */
const DEFAULT_TEXTAREA_ROWS = 6

function formatOutput(value: unknown, display: 'value' | 'json'): string {
  if (display === 'json') return JSON.stringify(value, null, 2) ?? 'undefined'
  return typeof value === 'string' ? value : String(value)
}

/**
 * What the static analysis found about this node, as a marker on its card.
 *
 * The card has room for a count and a severity; the findings themselves read in the checks list,
 * so the marker carries their text as its tooltip rather than growing the card.
 * @param diagnostics - The node's findings; never empty.
 * @param t - Translate.
 */
function DiagnosticBadge({ diagnostics, t }: {
  readonly diagnostics: readonly WorkflowDiagnostic[]
  readonly t: Translate
}) {
  const severity = diagnostics.some(item => DIAGNOSTIC_SEVERITY[item.code] === 'error') ? 'error' : 'warning'
  const title = diagnostics
    .map(item => [t(`diagnostics.${item.code}`), ...diagnosticDetails(item, t)].join(' · '))
    .join('\n')
  return (
    <span className={css.nodeDiagnostics} data-severity={severity} title={title}>
      {t(`diagnostics.${severity}`)} {diagnostics.length}
    </span>
  )
}

function assertNever(value: never): never {
  throw new Error(`Unknown node control: ${JSON.stringify(value)}`)
}
