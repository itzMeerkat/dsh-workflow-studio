/**
 * 调用别处定义的节点：原子节点调用原子目录中的函数，子工作流节点调用另一个工作流。
 *
 * 这类节点只记下它调用的是谁，端口来自被调用者的签名，因此被调用者变化时端口随之变化。
 * @module dsh-workflow-studio
 */

import { CODE_ATOM_TYPE, atomOf, signaturePorts, type Atom, type Signature } from './language.ts'
import { SUBWORKFLOW_TYPE, subworkflowOf, workflowSignature } from './subworkflow.ts'
import type { DagNodeDefinition, DagWorkflowDefinition, WorkflowId } from './types.ts'

/** 一个工作流的节点能调用的一切。 */
export interface Callees {
  /** 工作流原子目录中的原子，按文件名索引；没有原子目录时为空。 */
  readonly atoms: ReadonlyMap<string, Atom>
  /** 已保存的工作流，按 ID 索引。 */
  readonly workflows: ReadonlyMap<WorkflowId, DagWorkflowDefinition>
}

/** 什么也不能调用。 */
export const NO_CALLEES: Callees = { atoms: new Map(), workflows: new Map() }

/**
 * 节点是否调用别处定义的东西，端口由被调用者决定。
 * @param node - 任一节点。
 */
export function isCaller(node: Pick<DagNodeDefinition, 'type'>): boolean {
  return node.type === CODE_ATOM_TYPE || node.type === SUBWORKFLOW_TYPE
}

/**
 * 节点调用的签名。
 * @param node - 任一节点。
 * @param callees - 能调用的一切。
 * @returns 被调用者的签名；节点不调用别处，或被调用者不在 `callees` 中时为 undefined。
 */
export function calleeSignature(node: DagNodeDefinition, callees: Callees): Signature | undefined {
  switch (node.type) {
    case CODE_ATOM_TYPE:
      return callees.atoms.get(atomOf(node.config))?.signature
    case SUBWORKFLOW_TYPE: {
      const workflow = callees.workflows.get(subworkflowOf(node.config))
      return workflow === undefined ? undefined : workflowSignature(workflow)
    }
    default:
      return undefined
  }
}

/**
 * 按被调用者重读每个调用节点的端口，并去掉接在它已不再声明的端口上的数据边。
 *
 * 被调用者不在 `callees` 中时保留节点原有的端口，接线不因目录暂时读不到或列表尚未加载而丢失。
 * @param definition - 工作流定义。
 * @param callees - 能调用的一切。
 * @returns 调用节点的端口与被调用者签名一致的定义。
 */
export function withCallees(definition: DagWorkflowDefinition, callees: Callees): DagWorkflowDefinition {
  const nodes = definition.nodes.map((node) => {
    const signature = calleeSignature(node, callees)
    return signature === undefined
      ? node
      : { ...node, inputs: signaturePorts(signature.parameters), outputs: signaturePorts(signature.results) }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const declares = (node: DagNodeDefinition, ports: DagNodeDefinition['inputs'], port: string): boolean =>
    !isCaller(node) || (ports ?? []).some(candidate => candidate.name === port)
  return {
    ...definition,
    nodes,
    edges: definition.edges.filter((edge) => {
      if (edge.kind === 'exec') return true
      const source = byId.get(edge.source)!
      const target = byId.get(edge.target)!
      return declares(source, source.outputs, edge.sourcePort ?? 'output')
        && declares(target, target.inputs, edge.targetPort ?? 'input')
    }),
  }
}
