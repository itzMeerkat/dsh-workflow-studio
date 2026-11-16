/**
 * Host 侧静态分析诊断的文案。
 *
 * 分析只给出定位与事实，文案按使用它的界面组织：这里是保存异常与工具返回读的一句话，
 * 浏览器的同类文案由 `client/locale.ts` 的词典拥有。
 * @module dsh-workflow-studio
 */

import type { WorkflowDiagnostic } from './analysis.ts'
import { assertNever } from './errors.ts'

/**
 * 一条诊断的中文说明；错误同时给出可行的修改方式。
 * @param diagnostic - 分析给出的诊断。
 * @returns 一句话说明。
 */
export function describeDiagnostic(diagnostic: WorkflowDiagnostic): string {
  switch (diagnostic.code) {
    case 'starved-input':
      return `边 ${diagnostic.edgeId} 的源节点 ${diagnostic.sourceId} 可能被跳过，`
        + `而目标节点 ${diagnostic.nodeId} 仍会执行（${diagnostic.nodeId} 不依赖 ${diagnostic.pin} 触发）：`
        + `为 ${diagnostic.nodeId} 补一条执行边，或把输入端口 ${diagnostic.port} 声明为可选`
    case 'output-gap':
      return `工作流输出端口 ${diagnostic.port} 由 ${diagnostic.sourceId} 产生，`
        + `而它不在 ${diagnostic.pin} 未触发的分支上执行：该端口在这些分支下没有值，`
        + `把互斥分支的值先经 merge 汇合可以补齐`
    case 'merge-overlap':
      return `分支合并 ${diagnostic.nodeId} 的数据源 ${diagnostic.sources.join(' 与 ')} 不互斥，`
        + `同一次运行可能送达多个值，而它只接受一个`
    case 'merge-gap':
      return `分支合并 ${diagnostic.nodeId} 的数据源没有覆盖所有分支，`
        + `同一次运行可能一个值都收不到，而它至少需要一个`
    case 'type-mismatch':
      return `边 ${diagnostic.edgeId} 的上游实际产出 ${diagnostic.types[0]}，`
        + `与节点 ${diagnostic.nodeId} 输入端口 ${diagnostic.port} 声明的 ${diagnostic.types[1]} 不符`
    default:
      return assertNever(diagnostic)
  }
}
