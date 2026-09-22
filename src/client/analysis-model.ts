/** Static analysis of the graph being edited: diagnostics per node and the IR every source view writes out. */

import { analyzeWorkflow, indexNodeTypes } from '../shared/analysis.ts'
import type { WorkflowDiagnostic } from '../shared/analysis.ts'
import { topologicalLevels } from '../shared/graph.ts'
import { buildWorkflowIr, type WorkflowIr } from '../shared/ir.ts'
import type { DagWorkflowDefinition, NodeTypeSummary } from '../shared/types.ts'

/** What the panel shows about the graph currently on the canvas. */
export interface EditorAnalysis {
  /** Every diagnostic, in the order the analysis reports them. */
  readonly diagnostics: readonly WorkflowDiagnostic[]
  /** The diagnostics each node carries, keyed by node ID; nodes without any are absent. */
  readonly byNode: ReadonlyMap<string, readonly WorkflowDiagnostic[]>
  /** The graph in execution order, ready to be written in any language. */
  readonly ir: WorkflowIr
}

/**
 * Analyze the edited graph, or report that it cannot be analyzed yet.
 *
 * The analysis needs every node's type and an acyclic graph. A canvas can hold neither: a node's
 * plugin is not loaded, or the author wired a cycle. Both are already visible elsewhere, by the card
 * with no catalog entry and by the execution view, so this returns nothing rather than guessing.
 * Every edge joins two nodes, because the panel refuses to open a definition where one does not.
 * @param definition - The graph on the canvas.
 * @param nodeTypes - The node catalog from the snapshot.
 * @returns The analysis, or undefined when the graph cannot be analyzed.
 */
export function analyzeEditorGraph(
  definition: DagWorkflowDefinition,
  nodeTypes: readonly NodeTypeSummary[],
): EditorAnalysis | undefined {
  const catalog = indexNodeTypes(nodeTypes)
  if (definition.nodes.some(node => !catalog.has(node.type))) return undefined
  if (topologicalLevels(definition.nodes, definition.edges).cyclic.length > 0) return undefined

  const analysis = analyzeWorkflow(definition, catalog)
  const { diagnostics } = analysis
  const byNode = new Map<string, WorkflowDiagnostic[]>()
  for (const diagnostic of diagnostics) {
    const carried = byNode.get(diagnostic.nodeId)
    if (carried === undefined) byNode.set(diagnostic.nodeId, [diagnostic])
    else carried.push(diagnostic)
  }
  return { diagnostics, byNode, ir: buildWorkflowIr(definition, catalog, analysis) }
}
