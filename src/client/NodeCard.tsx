/** The node card both graphs render: identity, ports, inline controls, and displayed run outputs. */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { createContext, useContext } from 'react'
import type { NodeControlDefinition, PortDefinition } from '../shared/types.ts'
import { EXEC_RUN_PIN, execOutputPins } from '../shared/graph.ts'
import { handleId, nodeInputPorts, nodeOutputPorts, type WorkflowFlowNode, type WorkflowNodeData } from './graph-model.ts'
import type { Translate } from './locale.ts'
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
  /** Set when the card may edit configuration; absent in a read-only graph. */
  readonly updateConfig?: (nodeId: string, name: string, value: unknown) => void
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
  if (actions === undefined) throw new Error('Workflow node card rendered outside its view')
  const { t, updateConfig } = actions
  const inputs = nodeInputPorts(data)
  const outputs = nodeOutputPorts(data)
  const controls = data.catalog?.controls ?? []
  const runOutputs = displayedOutputs(data)
  const connectable = graph === 'data'
  return (
    <article className={`${css.canvasNode} ${selected ? css.canvasNodeSelected : ''}`}>
      {graph === 'execution' && (
        <Handle id="dependency" type="target" position={Position.Left} isConnectable={false} />
      )}
      <div className={css.nodeHeader}>
        <strong>{data.definition.label ?? data.catalog?.label ?? data.definition.type}</strong>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
      </div>
      <div className={css.nodeMeta}>
        <code>{data.definition.type}</code>
        {data.catalog !== undefined && <span>{data.catalog.sourcePlugin}</span>}
      </div>
      <div className={css.execPins}>
        <ExecPin pin={EXEC_RUN_PIN} side="input" connectable={connectable} />
        <div className={css.execPinGroup}>
          {execOutputPins(data.catalog ?? {}).map(pin => (
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
        <div>{inputs.map(port => <PortRow key={port.name} port={port} side="input" connectable={connectable} />)}</div>
        <div>{outputs.map(port => <PortRow key={port.name} port={port} side="output" connectable={connectable} />)}</div>
      </div>
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
      {runOutputs.length > 0 && (
        <div className={css.nodeOutputs}>
          <span className={css.nodeSection}>{t('node.output')}</span>
          {runOutputs.map(({ port, value }) => (
            <div key={port.name} className={css.nodeOutput}>
              <span>{port.name}</span>
              <output>{formatOutput(value, port.display ?? 'value')}</output>
            </div>
          ))}
        </div>
      )}
      {graph === 'execution' && (
        <Handle id="dependency" type="source" position={Position.Right} isConnectable={false} />
      )}
    </article>
  )
}

/** The output ports a run produced a displayable value for, in port order. */
function displayedOutputs(data: WorkflowNodeData): readonly { port: PortDefinition; value: unknown }[] {
  const produced = data.runRecord?.outputs
  if (produced === undefined) return []
  return nodeOutputPorts(data)
    .filter(port => port.display !== undefined && Object.hasOwn(produced, port.name))
    .map(port => ({ port, value: produced[port.name] }))
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

function PortRow({ port, side, connectable }: {
  readonly port: PortDefinition
  readonly side: 'input' | 'output'
  readonly connectable: boolean
}) {
  const isInput = side === 'input'
  return (
    <div
      className={`${css.port} ${isInput ? css.portInput : css.portOutput}`}
      title={port.description}
    >
      <Handle
        type={isInput ? 'target' : 'source'}
        position={isInput ? Position.Left : Position.Right}
        id={handleId({ kind: 'data', name: port.name })}
        isConnectable={connectable}
      />
      <span>
        {port.name}
        {isInput && port.required !== false && <b className={css.requiredPort}>*</b>}
      </span>
      <small>{port.type}</small>
    </div>
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
    default:
      return assertNever(control)
  }
}

function formatOutput(value: unknown, display: 'value' | 'json'): string {
  if (display === 'json') return JSON.stringify(value, null, 2) ?? 'undefined'
  return typeof value === 'string' ? value : String(value)
}

function assertNever(value: never): never {
  throw new Error(`Unknown node control: ${JSON.stringify(value)}`)
}
