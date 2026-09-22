/** The cards standing for a workflow's declared input and output ports, editable on the canvas. */

import { IconCloseOutlineRegular, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useContext, useState } from 'react'
import { EXEC_RUN_PIN, EXEC_THEN_PIN } from '../shared/graph.ts'
import type { PortDefinition, PortType } from '../shared/types.ts'
import { boundaryPorts, boundarySide } from '../shared/workflow-boundary.ts'
import { handleId, type WorkflowFlowNode } from './graph-model.ts'
import type { Translate, WorkflowStudioKey } from './locale.ts'
import { CardRunValues, NodeCardContext, type NodeCardGraph } from './NodeCard.tsx'
import {
  appendWorkflowPort,
  formatWorkflowPortDefault,
  parseWorkflowPortDefault,
  removeWorkflowPort,
  setWorkflowPortDefault,
  updateWorkflowPort,
  workflowPortFault,
  workflowResultValues,
  WORKFLOW_PORT_TYPES,
  type WorkflowPortEdit,
  type WorkflowPortSide,
} from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

const TITLE: Record<WorkflowPortSide, WorkflowStudioKey> = {
  inputs: 'workflowPorts.inputs',
  outputs: 'workflowPorts.outputs',
}

const FAULT: Record<'empty' | 'duplicate', WorkflowStudioKey> = {
  empty: 'workflowPorts.unnamed',
  duplicate: 'workflowPorts.duplicate',
}

/**
 * Render and edit the workflow ports one boundary node declares.
 * @param graph - Which graph the card is drawn in; the read-only one joins whole nodes.
 */
export function WorkflowBoundaryCard({ data, selected, graph = 'data' }: NodeProps<WorkflowFlowNode> & {
  readonly graph?: NodeCardGraph
}) {
  const actions = useContext(NodeCardContext)
  if (actions === undefined) throw new Error('Workflow boundary card rendered outside its view')
  const { t, updatePorts } = actions
  const node = data.definition
  const side = boundarySide(node)
  const ports = boundaryPorts(node)
  const isInput = side === 'inputs'
  const commit = (next: readonly PortDefinition[], edit: WorkflowPortEdit = { kind: 'other' }): void => {
    updatePorts?.(node.id, next, edit)
  }
  const returned = isInput ? [] : workflowResultValues(ports, data.runRecord)
  return (
    <article
      className={`${css.canvasNode} ${css.boundaryCard} ${selected ? css.canvasNodeSelected : ''}`}
      data-side={side}
    >
      {graph === 'execution' && (
        <Handle id="dependency" type="target" position={Position.Left} isConnectable={false} />
      )}
      <div className={css.nodeHeader}>
        <strong>{node.label ?? t(TITLE[side])}</strong>
        {data.runRecord !== undefined && (
          <span className={css.nodeStatus} data-status={data.runRecord.status}>
            {data.runRecord.status}
          </span>
        )}
        {updatePorts !== undefined && (
          <button
            type="button"
            className={css.workflowPortsAdd}
            aria-label={t('workflowPorts.add')}
            title={t('workflowPorts.add')}
            onClick={() => { commit(appendWorkflowPort(ports, side)) }}
          >
            <IconPlusOutlineRegular size={13} />
          </button>
        )}
      </div>
      <div className={css.execPins}>
        <BoundaryExecPin side={side} />
      </div>
      <ul className={css.boundaryPorts}>
        {ports.map((port, index) => {
          const fault = workflowPortFault(ports, index)
          return (
            // Rows are identified by position, so a name stays editable while it is typed.
            <li key={index} className={css.boundaryPort} {...(fault === undefined ? {} : { 'data-fault': fault })}>
              <Handle
                type={isInput ? 'source' : 'target'}
                position={isInput ? Position.Right : Position.Left}
                id={handleId({ kind: 'data', name: port.name })}
              />
              <input
                className="nodrag"
                value={port.name}
                aria-label={t('workflowPorts.name')}
                disabled={updatePorts === undefined}
                {...(fault === undefined ? {} : { title: t(FAULT[fault]) })}
                onChange={(event) => {
                  const renamed = event.currentTarget.value
                  commit(
                    updateWorkflowPort(ports, index, { name: renamed }),
                    { kind: 'renamed', from: port.name, to: renamed },
                  )
                }}
              />
              <select
                className="nodrag nowheel"
                value={port.type}
                aria-label={t('workflowPorts.type')}
                disabled={updatePorts === undefined}
                onChange={(event) => {
                  commit(updateWorkflowPort(ports, index, { type: event.currentTarget.value as PortType }))
                }}
              >
                {WORKFLOW_PORT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
              {isInput && (
                <DefaultField
                  port={port}
                  t={t}
                  disabled={updatePorts === undefined}
                  onChange={(value) => { commit(setWorkflowPortDefault(ports, index, value)) }}
                />
              )}
              {updatePorts !== undefined && (
                <button
                  type="button"
                  aria-label={t('workflowPorts.remove')}
                  title={t('workflowPorts.remove')}
                  onClick={() => {
                    commit(removeWorkflowPort(ports, index), { kind: 'removed', name: port.name })
                  }}
                >
                  <IconCloseOutlineRegular size={12} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {ports.length === 0 && <p>{t('workflowPorts.empty')}</p>}
      {graph === 'execution' && (
        <Handle id="dependency" type="source" position={Position.Right} isConnectable={false} />
      )}
      <CardRunValues title={t('node.output')} values={returned} />
    </article>
  )
}

/**
 * The execution pin of one boundary card.
 *
 * The outputs card takes a `run` pin so a decision can gate what the workflow gives back: an
 * execution edge that never fires skips the card, and the run then collects nothing. The inputs
 * card offers `then` so work can be ordered after the inputs are in.
 */
function BoundaryExecPin({ side }: { readonly side: WorkflowPortSide }) {
  const isInput = side === 'inputs'
  const pin = isInput ? EXEC_THEN_PIN : EXEC_RUN_PIN
  return (
    <div className={`${css.execPin} ${isInput ? css.execPinOutput : css.execPinInput}`} data-pin={pin}>
      <Handle
        type={isInput ? 'source' : 'target'}
        position={isInput ? Position.Right : Position.Left}
        id={handleId({ kind: 'exec', name: pin })}
      />
      <span>{pin}</span>
    </div>
  )
}

/**
 * The default value of one declared input.
 *
 * The field keeps what was typed until it parses as a value of the port's type, so a partly
 * typed number or JSON object survives long enough to finish typing.
 */
function DefaultField({ port, t, disabled, onChange }: {
  readonly port: PortDefinition
  readonly t: Translate
  readonly disabled: boolean
  readonly onChange: (value: PortDefinition['default']) => void
}) {
  const declared = formatWorkflowPortDefault(port.default, port.type)
  const [typed, setTyped] = useState({ text: declared, declared })
  if (typed.declared !== declared) setTyped({ text: declared, declared })
  return (
    <input
      className="nodrag"
      value={typed.text}
      aria-label={t('workflowPorts.default')}
      placeholder={t('workflowPorts.default')}
      disabled={disabled}
      onChange={(event) => {
        const text = event.currentTarget.value
        const parsed = parseWorkflowPortDefault(text, port.type)
        setTyped({ text, declared: parsed === 'invalid' ? typed.declared : formatWorkflowPortDefault(parsed.value, port.type) })
        if (parsed !== 'invalid') onChange(parsed.value)
      }}
    />
  )
}
