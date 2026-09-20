/** Canvas node card: ports, inline controls, and displayed run outputs. */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { createContext, useContext } from 'react'
import type { NodeControlDefinition, PortDefinition } from '../shared/types.ts'
import { EXEC_RUN_PIN, execOutputPins } from '../shared/graph.ts'
import { handleId, nodeInputPorts, nodeOutputPorts, type WorkflowFlowNode } from './graph-model.ts'
import css from './WorkflowStudioPanel.module.css'

/** Editor callbacks the node cards call. */
export interface NodeCardActions {
  readonly updateConfig: (nodeId: string, name: string, value: unknown) => void
}

/** Provides {@link NodeCardActions} to the cards React Flow renders. */
export const NodeCardContext = createContext<NodeCardActions | undefined>(undefined)

/** Render one workflow node on the canvas. */
export function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const actions = useContext(NodeCardContext)
  if (actions === undefined) throw new Error('Workflow node card rendered outside its editor')
  const inputs = nodeInputPorts(data)
  const outputs = nodeOutputPorts(data)
  const controls = data.catalog?.controls ?? []
  const runOutputs = data.runRecord?.outputs
  return (
    <div className={`${css.canvasNode} ${selected ? css.canvasNodeSelected : ''}`}>
      <div className={css.nodeHeader}>
        <strong>{data.definition.label ?? data.catalog?.label ?? data.definition.type}</strong>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
      </div>
      <code>{data.definition.type}</code>
      <div className={css.execPins}>
        <ExecPin pin={EXEC_RUN_PIN} side="input" />
        <div className={css.execPinGroup}>
          {execOutputPins(data.catalog ?? {}).map(pin => <ExecPin key={pin} pin={pin} side="output" />)}
        </div>
      </div>
      <div className={css.ports}>
        <div>{inputs.map(port => <PortRow key={port.name} port={port} side="input" />)}</div>
        <div>{outputs.map(port => <PortRow key={port.name} port={port} side="output" />)}</div>
      </div>
      {controls.length > 0 && (
        <div className={css.nodeControls}>
          {controls.map(control => (
            <NodeControl
              key={control.name}
              control={control}
              value={data.definition.config[control.name] ?? control.defaultValue}
              onChange={(value) => { actions.updateConfig(data.definition.id, control.name, value) }}
            />
          ))}
        </div>
      )}
      {runOutputs !== undefined && (
        <div className={css.nodeOutputs}>
          {outputs
            .filter(port => port.display !== undefined && Object.hasOwn(runOutputs, port.name))
            .map(port => (
              <div key={port.name} className={css.nodeOutput}>
                <span>{port.name}</span>
                <output>{formatOutput(runOutputs[port.name], port.display ?? 'value')}</output>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function ExecPin({ pin, side }: { readonly pin: string; readonly side: 'input' | 'output' }) {
  const isInput = side === 'input'
  return (
    <div className={`${css.execPin} ${isInput ? css.execPinInput : css.execPinOutput}`}>
      <Handle
        type={isInput ? 'target' : 'source'}
        position={isInput ? Position.Left : Position.Right}
        id={handleId({ kind: 'exec', name: pin })}
      />
      <span>{pin}</span>
    </div>
  )
}

function PortRow({ port, side }: { readonly port: PortDefinition; readonly side: 'input' | 'output' }) {
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
      />
      <span>
        {port.name}
        {isInput && port.required !== false && <b className={css.requiredPort}>*</b>}
      </span>
      <small>{port.type}</small>
    </div>
  )
}

function NodeControl({
  control,
  value,
  onChange,
}: {
  readonly control: NodeControlDefinition
  readonly value: unknown
  readonly onChange: (value: unknown) => void
}) {
  switch (control.kind) {
    case 'boolean':
      return (
        <label className={`${css.nodeControl} nodrag`}>
          <input
            type="checkbox"
            checked={value === true}
            onChange={event => { onChange(event.currentTarget.checked) }}
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
            onChange={event => { onChange(event.currentTarget.value) }}
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
            {...(control.min === undefined ? {} : { min: control.min })}
            {...(control.max === undefined ? {} : { max: control.max })}
            {...(control.step === undefined ? {} : { step: control.step })}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber
              if (Number.isFinite(next)) onChange(next)
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
            {...(control.placeholder === undefined ? {} : { placeholder: control.placeholder })}
            onChange={event => { onChange(event.currentTarget.value) }}
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
