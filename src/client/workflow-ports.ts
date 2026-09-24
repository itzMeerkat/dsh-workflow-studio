/**
 * Editing the workflow's own inputs and outputs, which the boundary nodes carry as their ports.
 * @module dsh-workflow-studio
 */

import {
  NodeId, type DagNodeDefinition, type DagWorkflowDefinition, type JsonObject, type JsonValue, type NodeRunRecord,
  type PortDefinition, type PortType,
} from '../shared/types.ts'
import { WORKFLOW_INPUT_TYPE, WORKFLOW_OUTPUT_TYPE, withBoundaryPorts } from '../shared/workflow-boundary.ts'

/** Which side of the workflow a declared port belongs to. */
export type WorkflowPortSide = 'inputs' | 'outputs'

/**
 * What one edit did to a side's ports, so the edges wired to them can follow.
 *
 * An edge names the port it connects, so a rename has to move its edges and a removal has to
 * take them with it. Adding a port, or changing its type or default, moves no edge.
 */
export type WorkflowPortEdit =
  | { readonly kind: 'renamed'; readonly from: string; readonly to: string }
  | { readonly kind: 'removed'; readonly name: string }
  | { readonly kind: 'other' }

/**
 * The boundary node of one side, as a new workflow places it: inputs on the left, outputs on the right.
 * @param side - Which side of the workflow the node stands for.
 */
export function boundaryNode(side: WorkflowPortSide): DagNodeDefinition {
  return side === 'inputs'
    ? { id: NodeId(WORKFLOW_INPUT_TYPE), type: WORKFLOW_INPUT_TYPE, config: {}, outputs: [], position: { x: 80, y: 80 } }
    : { id: NodeId(WORKFLOW_OUTPUT_TYPE), type: WORKFLOW_OUTPUT_TYPE, config: {}, inputs: [], position: { x: 720, y: 80 } }
}

/**
 * A definition whose workflow declares `ports` on one side.
 *
 * The ports live on that side's boundary node, which is where they are wired, so the node is added
 * back when the author deleted it. An edge names the port it connects, so a renamed port takes its
 * edges along and a removed port takes them away.
 * @param definition - The workflow being edited.
 * @param side - Which side the ports belong to.
 * @param ports - Every port that side now declares.
 * @param edit - What the change did to one port.
 * @returns The definition with the ports and the edges that follow them.
 */
export function withWorkflowPorts(
  definition: DagWorkflowDefinition,
  side: WorkflowPortSide,
  ports: readonly PortDefinition[],
  edit: WorkflowPortEdit,
): DagWorkflowDefinition {
  const type = side === 'inputs' ? WORKFLOW_INPUT_TYPE : WORKFLOW_OUTPUT_TYPE
  const node = definition.nodes.find(candidate => candidate.type === type) ?? boundaryNode(side)
  const nodes = definition.nodes.includes(node)
    ? definition.nodes.map(candidate => candidate === node ? withBoundaryPorts(candidate, ports) : candidate)
    : [...definition.nodes, withBoundaryPorts(node, ports)]
  if (edit.kind === 'other') return { ...definition, nodes }
  const name = edit.kind === 'renamed' ? edit.from : edit.name
  return {
    ...definition,
    nodes,
    edges: definition.edges.flatMap((edge) => {
      const onPort = edge.kind === 'data' && (side === 'inputs'
        ? edge.source === node.id && edge.sourcePort === name
        : edge.target === node.id && edge.targetPort === name)
      if (!onPort) return [edge]
      if (edit.kind === 'removed') return []
      return [side === 'inputs' ? { ...edge, sourcePort: edit.to } : { ...edge, targetPort: edit.to }]
    }),
  }
}

/** Why a declared port cannot be referenced. */
export type WorkflowPortFault = 'empty' | 'duplicate'

/**
 * Append a port named after its side, numbered past the names already taken.
 *
 * A new output is optional, because a workflow output is often fed by one branch of several and
 * a required one would refuse to save until every path could produce it.
 * @param ports - The ports declared on that side.
 * @param side - Which side the new port belongs to.
 * @returns The ports with one more at the end.
 */
export function appendWorkflowPort(
  ports: readonly PortDefinition[],
  side: WorkflowPortSide,
): PortDefinition[] {
  const base = side === 'inputs' ? 'input' : 'output'
  const taken = new Set(ports.map(port => port.name))
  for (let index = 1; ; index += 1) {
    const name = `${base}${index}`
    if (taken.has(name)) continue
    return [...ports, side === 'inputs' ? { name, type: 'any' } : { name, type: 'any', required: false }]
  }
}

/**
 * Replace the name or type of one declared port, keeping its other fields.
 * @param ports - The ports declared on that side.
 * @param index - Which port to change.
 * @param patch - The fields to replace.
 * @returns The ports with that one changed.
 */
export function updateWorkflowPort(
  ports: readonly PortDefinition[],
  index: number,
  patch: Partial<Pick<PortDefinition, 'name' | 'type'>>,
): PortDefinition[] {
  return ports.map((port, position) => position === index ? { ...port, ...patch } : port)
}

/**
 * Drop one declared port.
 * @param ports - The ports declared on that side.
 * @param index - Which port to drop.
 * @returns The remaining ports.
 */
export function removeWorkflowPort(ports: readonly PortDefinition[], index: number): PortDefinition[] {
  return ports.filter((_port, position) => position !== index)
}

/**
 * Why one declared port cannot be referenced.
 *
 * An edge names the port it connects, so an unnamed port names nothing and a repeated name
 * names two things.
 * @param ports - The ports declared on that side.
 * @param index - Which port to judge.
 * @returns The fault, or undefined when the port is usable.
 */
export function workflowPortFault(
  ports: readonly PortDefinition[],
  index: number,
): WorkflowPortFault | undefined {
  const name = ports[index]?.name.trim()
  if (name === undefined || name === '') return 'empty'
  return ports.some((port, position) => position !== index && port.name.trim() === name)
    ? 'duplicate'
    : undefined
}

/**
 * The text shown for one port's default value; an absent default shows as an empty field.
 * @param value - The declared default, if any.
 * @param type - The port's declared type.
 * @returns The text to edit.
 */
export function formatWorkflowPortDefault(value: JsonValue | undefined, type: PortType): string {
  if (value === undefined) return ''
  // A string port edits its own text, so a default does not have to be typed as a JSON string.
  if (type === 'string') return typeof value === 'string' ? value : JSON.stringify(value)
  return JSON.stringify(value)
}

/**
 * The default value one port's text stands for.
 *
 * An empty field declares no default, which makes the input required at the call site.
 * @param text - What was typed.
 * @param type - The port's declared type.
 * @returns The value, `undefined` for no default, or `'invalid'` when the text is not one.
 */
export function parseWorkflowPortDefault(
  text: string,
  type: PortType,
): { readonly value: JsonValue | undefined } | 'invalid' {
  if (text.trim() === '') return { value: undefined }
  if (type === 'string') return { value: text }
  if (type === 'number') {
    const value = Number(text)
    return Number.isFinite(value) ? { value } : 'invalid'
  }
  if (type === 'boolean') {
    if (text === 'true') return { value: true }
    return text === 'false' ? { value: false } : 'invalid'
  }
  try {
    return { value: JSON.parse(text) as JsonValue }
  } catch (error: unknown) {
    // The text is being typed; an incomplete value is not yet a default.
    void error
    return 'invalid'
  }
}

/**
 * One port with its default replaced; `undefined` removes the default.
 * @param ports - The ports declared on that side.
 * @param index - Which port to change.
 * @param value - The new default, or undefined for none.
 * @returns The ports with that one changed.
 */
export function setWorkflowPortDefault(
  ports: readonly PortDefinition[],
  index: number,
  value: JsonValue | undefined,
): PortDefinition[] {
  return ports.map((port, position) => {
    if (position !== index) return port
    const { default: _previous, ...rest } = port
    return value === undefined ? rest : { ...rest, default: value }
  })
}

/** Why one typed run input cannot be used. */
export interface WorkflowRunInputFault {
  readonly name: string
  /** `missing`: the field is empty and the port declares no default. `invalid`: the text is not a value of the port's type. */
  readonly kind: 'missing' | 'invalid'
}

/**
 * The run input values a set of typed fields stands for.
 *
 * A field left empty falls back to the port's default, so it is omitted rather than sent as
 * nothing; a port with no default has nothing to fall back to and is reported instead.
 * @param ports - The workflow's declared input ports.
 * @param typed - What was typed, by port name.
 * @returns The values to start the run with, or the first port that cannot be used.
 */
export function workflowRunInputs(
  ports: readonly PortDefinition[],
  typed: Readonly<Record<string, string>>,
): { readonly values: JsonObject } | { readonly fault: WorkflowRunInputFault } {
  const values: JsonObject = {}
  for (const port of ports) {
    const parsed = parseWorkflowPortDefault(typed[port.name] ?? '', port.type)
    if (parsed === 'invalid') return { fault: { name: port.name, kind: 'invalid' } }
    if (parsed.value === undefined) {
      if (port.default === undefined) return { fault: { name: port.name, kind: 'missing' } }
      continue
    }
    values[port.name] = parsed.value
  }
  return { values }
}

/** The text each declared input starts with in the run dialog: its default, or an empty field. */
export function workflowRunDefaults(
  ports: readonly PortDefinition[],
): Record<string, string> {
  return Object.fromEntries(ports.map(port => [port.name, formatWorkflowPortDefault(port.default, port.type)]))
}

/**
 * What the latest run delivered to each declared output port, in declared order.
 *
 * The output boundary node declares no output ports of its own, so what the workflow returned is
 * what that node received: its run record's `inputs`. A port nothing reached is left out, which
 * is how a branch that did not run reads on the card.
 * @param ports - The output ports the boundary node declares.
 * @param runRecord - That node's latest run record, if the run reached it.
 * @returns One entry per port that carries a value.
 */
export function workflowResultValues(
  ports: readonly PortDefinition[],
  runRecord: NodeRunRecord | undefined,
): readonly { readonly name: string; readonly value: unknown }[] {
  const delivered = runRecord?.inputs
  if (delivered === undefined) return []
  return ports
    .filter(port => Object.hasOwn(delivered, port.name))
    .map(port => ({ name: port.name, value: delivered[port.name] }))
}
