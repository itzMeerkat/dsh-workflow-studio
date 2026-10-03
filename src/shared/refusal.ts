/**
 * 作者能自己改正的拒绝：保存、运行或送达结果时，引擎因请求本身不成立而拒绝它，而不是因为出了故障。
 *
 * 拒绝只给出类别与事实，不含文案：Host 的异常信息由 {@link describeRefusal} 组织，浏览器按 `code` 从自己的词典组织，
 * 因此两种语言的界面都读得懂。其余错误是意外，Remote 把它们报告为内部错误。
 * @module dsh-workflow-studio
 */

import type { WorkflowDiagnostic } from './analysis.ts'
import { describeDiagnostic } from './diagnostic-message.ts'
import { assertNever } from './errors.ts'
import type { WorkflowKind } from './types.ts'

/** 一次拒绝；`code` 决定其余字段。 */
export type WorkflowRefusal =
  /** 另一个工作流已使用这个名称。 */
  | { readonly code: 'name-taken'; readonly name: string }
  /** 另一种类的工作流已使用这个名称。 */
  | { readonly code: 'name-taken-by-kind'; readonly name: string; readonly kind: WorkflowKind }
  | { readonly code: 'workflow-missing'; readonly workflow: string }
  /** 工作流的种类一经保存就不再改变。 */
  | { readonly code: 'kind-change'; readonly workflow: string; readonly from: WorkflowKind; readonly to: WorkflowKind }
  /** 被嵌入的工作流不能改名或删除，否则嵌入它的地方会断开。 */
  | { readonly code: 'embedded'; readonly name: string; readonly embedders: readonly string[]; readonly action: 'rename' | 'delete' }
  /** `code` 工作流只写成源码，不能运行。 */
  | { readonly code: 'not-runnable'; readonly workflow: string; readonly kind: WorkflowKind }
  | { readonly code: 'run-missing'; readonly run: string }
  | { readonly code: 'run-ended'; readonly run: string }
  | { readonly code: 'run-node-missing'; readonly run: string; readonly node: string }
  | { readonly code: 'request-missing'; readonly node: string; readonly request: string }
  | { readonly code: 'request-answered'; readonly request: string }
  /** 节点类型拒绝了送达的结果；`reason` 是节点给出的原文。 */
  | { readonly code: 'result-rejected'; readonly reason: string }
  | { readonly code: 'input-undeclared'; readonly input: string }
  | { readonly code: 'input-missing'; readonly input: string }
  /** 子工作流直接或间接嵌入了自己；`trail` 是沿嵌入关系走过的工作流。 */
  | { readonly code: 'embed-cycle'; readonly trail: readonly string[] }
  | { readonly code: 'embedded-workflow-missing'; readonly node: string; readonly workflow: string }
  | { readonly code: 'language-unknown'; readonly language: string; readonly languages: readonly string[] }
  | { readonly code: 'folder-relative'; readonly folder: string }
  /** 目录读不出，例如不存在或没有权限；`reason` 是操作系统给出的原文。 */
  | { readonly code: 'folder-unreadable'; readonly folder: string; readonly reason: string }
  /** 原子目录必须是绝对路径，且只用于能读原子的语言。 */
  | { readonly code: 'atom-folder-invalid'; readonly folder: string }
  | { readonly code: 'boundary-duplicate'; readonly side: 'inputs' | 'outputs' }
  | { readonly code: 'node-kind'; readonly type: string; readonly kinds: readonly WorkflowKind[]; readonly kind: WorkflowKind }
  | { readonly code: 'cycle'; readonly nodes: readonly string[] }
  | { readonly code: 'node-duplicate'; readonly node: string }
  | { readonly code: 'node-type-unknown'; readonly type: string }
  | { readonly code: 'port-duplicate'; readonly node: string; readonly side: 'inputs' | 'outputs'; readonly port: string }
  /** 多路分支的 case 为空、重复或与 default 引脚同名。 */
  | { readonly code: 'switch-case'; readonly node: string; readonly case: string }
  | { readonly code: 'edge-duplicate'; readonly edge: string }
  | { readonly code: 'edge-node-missing'; readonly edge: string; readonly end: 'source' | 'target'; readonly node: string }
  | { readonly code: 'exec-pin-missing'; readonly edge: string; readonly end: 'source' | 'target'; readonly node: string; readonly pin: string }
  | { readonly code: 'exec-edge-duplicate'; readonly edge: string; readonly source: string; readonly sourcePin: string; readonly target: string; readonly targetPin: string }
  | { readonly code: 'port-missing'; readonly edge: string; readonly side: 'inputs' | 'outputs'; readonly node: string; readonly port: string }
  | {
    readonly code: 'port-incompatible'
    readonly edge: string
    readonly source: string
    readonly sourcePort: string
    readonly sourceType: string
    readonly target: string
    readonly targetPort: string
    readonly targetType: string
  }
  | { readonly code: 'input-overwired'; readonly node: string; readonly port: string }
  | { readonly code: 'input-unwired'; readonly node: string; readonly port: string }
  | { readonly code: 'variadic-min'; readonly node: string; readonly min: number }
  | { readonly code: 'variadic-input-type'; readonly node: string }
  | { readonly code: 'variadic-output-type'; readonly node: string }
  /** 整图分析给出了严重程度为 error 的诊断。 */
  | { readonly code: 'diagnostic'; readonly diagnostic: WorkflowDiagnostic }

/** 拒绝的类别。 */
export type WorkflowRefusalCode = WorkflowRefusal['code']

/** 引擎拒绝一个作者能自己改正的请求时抛出；信息是 {@link describeRefusal} 的中文说明。 */
export class WorkflowRefusalError extends Error {
  /** @param refusal - 拒绝的类别与事实。 */
  constructor(readonly refusal: WorkflowRefusal) {
    super(describeRefusal(refusal))
    this.name = 'WorkflowRefusalError'
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 引擎拒绝了一个作者能自己改正的请求；浏览器按 `refusal.code` 组织文案。 */
    'workflowStudio/refused': { readonly refusal: WorkflowRefusal }
  }
}

const SIDE = { inputs: '输入', outputs: '输出' } as const
const END = { source: '源', target: '目标' } as const

/**
 * 一次拒绝的中文说明，供 Host 日志、模型工具和异常信息使用；浏览器的文案由 `client/locale.ts` 拥有。
 * @param refusal - 拒绝。
 * @returns 一句话说明。
 */
export function describeRefusal(refusal: WorkflowRefusal): string {
  switch (refusal.code) {
    case 'name-taken':
      return `工作流名称 "${refusal.name}" 已存在`
    case 'name-taken-by-kind':
      return `工作流名称 "${refusal.name}" 已被一个 ${refusal.kind} 工作流使用`
    case 'workflow-missing':
      return `工作流 "${refusal.workflow}" 不存在`
    case 'kind-change':
      return `工作流 "${refusal.workflow}" 是 ${refusal.from} 工作流，不能改为 ${refusal.to} 工作流`
    case 'embedded':
      return `工作流 "${refusal.name}" 被 ${refusal.embedders.map(name => `"${name}"`).join('、')} 作为子工作流嵌入，不能${refusal.action === 'rename' ? '改名' : '删除'}`
    case 'not-runnable':
      return `工作流 ${refusal.workflow} 是 ${refusal.kind} 工作流，只写成源码，不能运行`
    case 'run-missing':
      return `运行 ${refusal.run} 不存在`
    case 'run-ended':
      return `运行 ${refusal.run} 已结束`
    case 'run-node-missing':
      return `运行 ${refusal.run} 没有节点 ${refusal.node}`
    case 'request-missing':
      return `节点 ${refusal.node} 没有请求 ${refusal.request}`
    case 'request-answered':
      return `请求 ${refusal.request} 已送达结果`
    case 'result-rejected':
      return `结果被节点拒绝: ${refusal.reason}`
    case 'input-undeclared':
      return `工作流未声明输入 "${refusal.input}"`
    case 'input-missing':
      return `工作流输入 "${refusal.input}" 未提供值，且没有默认值`
    case 'embed-cycle':
      return `子工作流嵌入成环：${refusal.trail.join(' → ')}`
    case 'embedded-workflow-missing':
      return `子工作流节点 ${refusal.node} 嵌入的工作流 ${refusal.workflow} 不存在`
    case 'language-unknown':
      return `code 工作流的语言必须是 ${refusal.languages.join('、')} 之一，而不是 ${refusal.language === '' ? '空' : refusal.language}`
    case 'folder-relative':
      return `目录必须是绝对路径: ${refusal.folder}`
    case 'folder-unreadable':
      return `目录 ${refusal.folder} 读不出: ${refusal.reason}`
    case 'atom-folder-invalid':
      return `原子目录必须是绝对路径，且只用于能读原子的语言: ${refusal.folder}`
    case 'boundary-duplicate':
      return `工作流最多只能有一个${SIDE[refusal.side]}边界节点`
    case 'node-kind':
      return `节点类型 ${refusal.type} 只能用在 ${refusal.kinds.join('、')} 工作流中，而本工作流是 ${refusal.kind}`
    case 'cycle':
      return `工作流包含环：${refusal.nodes.join(', ')}`
    case 'node-duplicate':
      return `节点 ID "${refusal.node}" 重复`
    case 'node-type-unknown':
      return `未知节点类型: ${refusal.type}`
    case 'port-duplicate':
      return `节点 ${refusal.node} 的${SIDE[refusal.side]}端口 ${refusal.port} 重复`
    case 'switch-case':
      return `节点 ${refusal.node} 的 case "${refusal.case}" 为空、重复或与 default 引脚同名`
    case 'edge-duplicate':
      return `边 ID "${refusal.edge}" 重复`
    case 'edge-node-missing':
      return `边 ${refusal.edge} 引用不存在的${END[refusal.end]}节点 ${refusal.node}`
    case 'exec-pin-missing':
      return `执行边 ${refusal.edge} 引用节点 ${refusal.node} 不存在的执行${refusal.end === 'source' ? '输出' : '输入'}引脚 ${refusal.pin}`
    case 'exec-edge-duplicate':
      return `执行边 ${refusal.edge} 与已有的 ${refusal.source}.${refusal.sourcePin} -> ${refusal.target}.${refusal.targetPin} 重复`
    case 'port-missing':
      return `边 ${refusal.edge} 引用节点 ${refusal.node} 不存在的${SIDE[refusal.side]}端口 ${refusal.port}`
    case 'port-incompatible':
      return `边 ${refusal.edge} 的端口类型不兼容: ${refusal.source}.${refusal.sourcePort} (${refusal.sourceType})`
        + ` -> ${refusal.target}.${refusal.targetPort} (${refusal.targetType})`
    case 'input-overwired':
      return `节点 ${refusal.node} 的输入端口 ${refusal.port} 存在多条入边`
    case 'input-unwired':
      return `节点 ${refusal.node} 的输入端口 ${refusal.port} 缺少入边`
    case 'variadic-min':
      return `节点 ${refusal.node} 至少需要 ${refusal.min} 个输入端口`
    case 'variadic-input-type':
      return `节点 ${refusal.node} 的所有输入端口必须使用相同类型`
    case 'variadic-output-type':
      return `节点 ${refusal.node} 的输出端口必须与输入端口使用相同类型`
    case 'diagnostic':
      return describeDiagnostic(refusal.diagnostic)
    default:
      return assertNever(refusal)
  }
}

/**
 * 抛出一次拒绝。
 * @param refusal - 拒绝的类别与事实。
 * @throws 总是抛出 {@link WorkflowRefusalError}。
 */
export function refuse(refusal: WorkflowRefusal): never {
  throw new WorkflowRefusalError(refusal)
}
