/**
 * Geometry of the read-only execution graph: one band per stage, with its cards stacked inside it.
 *
 * The bands carry the stage numbers, so the cards themselves stay identical to the canvas cards.
 * @module dsh-workflow-studio
 */

import { execOutputPins } from '../shared/graph.ts'
import type { NodeId } from '../shared/types.ts'
import { boundaryPorts, WORKFLOW_OUTPUT_TYPE } from '../shared/workflow-boundary.ts'
import { CARD_WIDTH, nodeInputPorts, nodeOutputPorts, type WorkflowNodeData } from './graph-model.ts'
import { workflowResultValues } from './workflow-ports.ts'

/** Stage column geometry in pixels; the cards keep their default width, {@link CARD_WIDTH}. */
const LAYOUT = {
  stagePadding: 16,
  stageHeader: 30,
  stageGap: 44,
  cardGap: 28,
} as const

/** Card heights in pixels, one entry per section the stylesheet lays out. */
const CARD_METRICS = {
  frame: 22,
  header: 18,
  meta: 16,
  section: 18,
  pin: 16,
  pinGap: 4,
  port: 18,
  control: 32,
  output: 30,
  minimum: 92,
} as const

/** The band behind one stage's cards. */
export interface StageBandLayout {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One card's place inside its stage band, as an offset from the band's top left. */
export interface StageCardLayout {
  readonly nodeId: NodeId
  readonly bandId: string
  readonly x: number
  readonly y: number
}

/** Where every band and card of the execution graph is drawn. */
export interface ExecutionLayout {
  readonly bands: readonly StageBandLayout[]
  readonly cards: readonly StageCardLayout[]
}

/**
 * The height a card is expected to render at.
 *
 * The execution graph places its cards before the browser has measured any of them, so it needs
 * this estimate to stack a column without overlap. A card that renders shorter than the estimate
 * only leaves a gap, so every section counts at its tallest.
 * @param data - The node the card will show.
 * @returns The estimated height in pixels.
 */
export function estimateNodeCardHeight(data: WorkflowNodeData): number {
  const pins = Math.max(1, execOutputPins(data.catalog ?? {}).length)
  const ports = Math.max(nodeInputPorts(data).length, nodeOutputPorts(data).length)
  const controls = data.catalog?.controls.length ?? 0
  const outputs = displayedOutputCount(data)
  const height = CARD_METRICS.frame + CARD_METRICS.header + CARD_METRICS.meta
    + CARD_METRICS.section + pins * CARD_METRICS.pin + (pins - 1) * CARD_METRICS.pinGap
    + CARD_METRICS.section + ports * CARD_METRICS.port
    + (controls === 0 ? 0 : CARD_METRICS.section + controls * CARD_METRICS.control)
    + (outputs === 0 ? 0 : CARD_METRICS.section + CARD_METRICS.meta + outputs * CARD_METRICS.output)
  return Math.max(CARD_METRICS.minimum, height)
}

/**
 * Lay the stages out left to right, stacking each stage's cards inside its band.
 * @param stages - The cards of every stage, in scheduling order.
 * @param stageLabel - Localized word naming one stage; the band appends its number.
 * @returns The bands and the card offsets inside them.
 */
export function executionLayout(
  stages: readonly (readonly WorkflowNodeData[])[],
  stageLabel: string,
): ExecutionLayout {
  const bands: StageBandLayout[] = []
  const cards: StageCardLayout[] = []
  const width = CARD_WIDTH + LAYOUT.stagePadding * 2
  stages.forEach((stage, index) => {
    const heights = stage.map(card => estimateNodeCardHeight(card))
    const id = `stage:${index + 1}`
    let cardY = LAYOUT.stageHeader
    stage.forEach((card, position) => {
      cards.push({ nodeId: card.definition.id, bandId: id, x: LAYOUT.stagePadding, y: cardY })
      cardY += heights[position]! + LAYOUT.cardGap
    })
    bands.push({
      id,
      label: `${stageLabel} ${index + 1}`,
      x: index * (width + LAYOUT.stageGap),
      y: 0,
      width,
      height: LAYOUT.stageHeader + LAYOUT.stagePadding
        + heights.reduce((total, height) => total + height, 0)
        + Math.max(0, heights.length - 1) * LAYOUT.cardGap,
    })
  })
  return { bands, cards }
}

/** How many values the card will list for the latest run. */
function displayedOutputCount(data: WorkflowNodeData): number {
  // The workflow's output card lists what it received, which is nowhere in its own outputs.
  if (data.definition.type === WORKFLOW_OUTPUT_TYPE) {
    return workflowResultValues(boundaryPorts(data.definition), data.runRecord).length
  }
  const produced = data.runRecord?.outputs
  if (produced === undefined) return 0
  return nodeOutputPorts(data)
    .filter(port => port.display !== undefined && Object.hasOwn(produced, port.name))
    .length
}
