/** The cards standing for a workflow's declared input and output ports, which the canvas wires. */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useContext } from 'react'
import { EXEC_RUN_PIN, EXEC_THEN_PIN } from '../shared/graph.ts'
import { typeName } from '../shared/language.ts'
import { boundaryPorts, boundarySide } from '../shared/workflow-boundary.ts'
import { handleId, type WorkflowFlowNode } from './graph-model.ts'
import type { WorkflowStudioKey } from './locale.ts'
import { CardResizer, CardRunValues, NodeCardContext, cardClass, type NodeCardGraph } from './NodeCard.tsx'
import { formatWorkflowPortDefault, workflowResultValues, type WorkflowPortSide } from './workflow-ports.ts'
import css from './WorkflowStudioPanel.module.css'

const TITLE: Record<WorkflowPortSide, WorkflowStudioKey> = {
  inputs: 'workflowPorts.inputs',
  outputs: 'workflowPorts.outputs',
}

/**
 * Render the workflow ports one boundary node declares. The workflow settings panel edits them;
 * the card only shows them and offers one handle per port.
 * @param graph - Which graph the card is drawn in; the read-only one joins whole nodes.
 */
export function WorkflowBoundaryCard({ data, selected, graph = 'data' }: NodeProps<WorkflowFlowNode> & {
  readonly graph?: NodeCardGraph
}) {
  const actions = useContext(NodeCardContext)
  if (actions === undefined) throw new Error('Workflow boundary card rendered outside its view')
  const { t, language } = actions
  const node = data.definition
  const side = boundarySide(node)
  const ports = boundaryPorts(node)
  const isInput = side === 'inputs'
  const returned = isInput ? [] : workflowResultValues(ports, data.runRecord)
  return (
    <article className={`${cardClass(graph, selected)} ${css.boundaryCard}`} data-side={side}>
      {graph === 'data' && <CardResizer />}
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
      </div>
      <div className={css.execPins}>
        <BoundaryExecPin side={side} />
      </div>
      <div className={css.ports}>
        <div>
          {ports.map((port) => {
            const type = typeName(language, port.type)
            const described = port.default === undefined ? type : `${type} = ${formatWorkflowPortDefault(port.default, port.type)}`
            return (
              <div key={port.name} className={`${css.port} ${isInput ? css.portOutput : css.portInput}`} title={`${port.name} ${described}`}>
                <Handle
                  type={isInput ? 'source' : 'target'}
                  position={isInput ? Position.Right : Position.Left}
                  id={handleId({ kind: 'data', name: port.name })}
                  isConnectable={graph === 'data'}
                />
                <span>{port.name}</span>
                <small>{described}</small>
              </div>
            )
          })}
        </div>
      </div>
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
