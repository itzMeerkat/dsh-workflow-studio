/**
 * 模型面工作流管理工具：create_workflow、describe_workflow、run_workflow 和 get_workflow_run。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DIAGNOSTIC_SEVERITY, analyzeWorkflow, indexNodeTypes, type WorkflowAnalysis } from './shared/analysis.ts'
import { describeDiagnostic, describeRenderFault } from './diagnostic-message.ts'
import { buildWorkflowIr } from './shared/ir.ts'
import { saveWithFile, workflowCallees } from './atom-folder.ts'
import { withCallees } from './shared/callees.ts'
import { CODE_LANGUAGES, languageOf } from './shared/language.ts'
import { RenderError, renderWorkflow } from './shared/source.ts'
import { RunId, type JsonObject, type NodeTypeSummary } from './shared/types.ts'
import { toJsonObject } from './shared/json.ts'
import { workflowDefinitionSchema } from './shared/workflow-schema.ts'

/**
 * 注册所有工作流模型工具；每个工具随 `ctx` 卸载。
 * @param ctx - Cordis context，需已加载 dagEngine 与 workflowNodeRegistry 服务。
 */
export function registerWorkflowTools(ctx: Context): void {
  const engine = ctx.dagEngine
  const catalog = (): ReadonlyMap<string, NodeTypeSummary> => indexNodeTypes(ctx.workflowNodeRegistry.listTypes())
  // 已保存的定义不含 error 级诊断，保存时就会被拒绝，因此这里只会剩下告警。
  const warningsOf = (analysis: WorkflowAnalysis): string[] => analysis.diagnostics
    .filter(diagnostic => DIAGNOSTIC_SEVERITY[diagnostic.code] === 'warning')
    .map(describeDiagnostic)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'create_workflow',
    description: '创建或更新一个 DAG 工作流定义。接受完整的 JSON 节点/边定义，验证后持久化。同名定义会覆盖更新。',
    parameters: {
      name: { type: 'string', required: true, description: '工作流名称' },
      description: { type: 'string', description: '工作流描述' },
      kind: {
        type: 'string',
        description: '工作流种类：run（默认）由引擎执行；code 的节点携带 language 的代码，用 describe_workflow 写成源码。',
      },
      language: {
        type: 'string',
        description: `code 工作流的语言：${CODE_LANGUAGES.map(({ name }) => name).join('、')}。`
      },
      atomFolder: {
        type: 'string',
        description: 'go 工作流的原子目录，Host 上的绝对路径，一个 Go 包。目录中每个 .go 文件导出一个函数，自定义类型声明在 types.go，'
          + '用 { type: "code-atom", config: { atom: "<文件名>" } } 的节点调用它；保存时按该函数的签名填写节点的 inputs 和 outputs，'
          + '端口名就是参数名和结果名（未命名的结果为 output 或 output1、output2……），指针参数是可选端口。'
          + '端口类型就是 Go 类型的写法，例如 int、Order、*Coupon，但 float64、bool、string、any 写作 number、boolean、string、any；'
          + '工作流边界端口也这样声明类型，数据边两端的类型必须相同，除非一端是 any。'
          + '保存还把工作流函数写成目录中的 <工作流 ID>.workflow.go；写不出时不保存。',
      },
      nodes: {
        type: 'array',
        required: true,
        description: '节点列表。每个节点包含 id, type, label?, config?, inputs?, outputs?。'
          + '工作流自身的输入输出由两个边界节点承担：类型 workflow-input 的节点，其 outputs 就是'
          + '工作流接受的输入，每个端口可带 default；类型 workflow-output 的节点，其 inputs 就是'
          + '工作流产出的输出，通常声明为 required: false。每侧最多一个。'
          + '{ type: "subworkflow", config: { workflow: "<工作流 ID>" } } 把另一个同种类的已保存工作流当作一个节点：'
          + '它的输入输出端口就是那个工作流声明的输入和输出，保存时自动填写；run 工作流运行时展开它，'
          + 'code 工作流调用它生成的函数，因此两者须在同一原子目录。不能形成嵌入环，被嵌入的工作流不能改名。',
        items: { type: 'json' },
      },
      edges: {
        type: 'array',
        required: true,
        description: '边列表。每条边包含 id, kind, source, target, sourcePort?, targetPort?。'
          + 'kind 为 "data" 时按端口传递数据，sourcePort/targetPort 默认为 "output"/"input"；'
          + 'kind 为 "exec" 时只控制执行顺序，目标节点在源节点完成后才执行，源节点未完成则目标节点被跳过，'
          + 'sourcePort/targetPort 默认为 "then"/"run"。',
        items: { type: 'json' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: '工作流定义 ID' },
          name: { type: 'string', description: '工作流名称' },
          nodeCount: { type: 'number', description: '节点数量' },
          warnings: {
            type: 'array',
            description: '整图分析给出的告警；它们不阻止保存，但指出只在部分分支下成立的接线。',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      render: (_args, { name, workflowId, nodeCount, warnings = [] }) => [
        { type: 'text', text: `工作流 "${name}" 已保存 (ID: ${workflowId}, ${nodeCount} 个节点)` },
        ...warnings.map(warning => ({ type: 'text' as const, text: `告警: ${warning}` })),
      ],
    },
    async execute(args, _exec) {
      const parsed = workflowDefinitionSchema.parse({
        name: args.name,
        nodes: args.nodes,
        edges: args.edges,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.language === undefined ? {} : { language: args.language }),
        ...(args.atomFolder === undefined ? {} : { atomFolder: args.atomFolder }),
        ...(args.description === undefined ? {} : { description: args.description }),
      })
      const def = withCallees(parsed, await workflowCallees(parsed, engine))
      const workflowId = await saveWithFile(
        def,
        { registry: ctx.workflowNodeRegistry, engine },
        () => engine.save(def),
        engine.findByName(def.name)?.id,
      )
      return {
        workflowId,
        name: args.name,
        nodeCount: args.nodes.length,
        warnings: warningsOf(analyzeWorkflow(def, catalog())),
      }
    },
  })), 'workflow-tools:create_workflow')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'describe_workflow',
    description: '把一个已定义的工作流写成它的语言的一个函数：按执行顺序缩进，分支写成 if/else。'
      + 'run 工作流写成伪代码，节点是对节点类型的调用、数据边是实参，读它比读节点/边 JSON 更快看出工作流做什么；'
      + 'code 工作流写成它指定的语言，语句节点的代码按位置和所属分支原样写出，原子节点按数据边调用原子目录中的函数；'
      + '子工作流写成对它嵌入的工作流的调用。源码与保存时写进原子目录的文件相同。同时给出整图分析的告警。',
    parameters: {
      name: { type: 'string', required: true, description: '工作流名称' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工作流名称' },
          language: { type: 'string', description: '写成的语言' },
          source: { type: 'string', description: '生成的源码' },
          warnings: { type: 'array', description: '整图分析给出的告警。', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_args, { source = '', warnings = [] }) => [
        { type: 'text', text: source },
        ...warnings.map(warning => ({ type: 'text' as const, text: `告警: ${warning}` })),
      ],
    },
    async execute(args, _exec) {
      const summary = engine.findByName(args.name)
      if (summary === undefined) throw new Error(`未找到工作流: ${args.name}`)
      const definition = engine.get(summary.id)!
      const language = languageOf(definition)
      const types = catalog()
      const analysis = analyzeWorkflow(definition, types)
      let source: string
      try {
        source = renderWorkflow(buildWorkflowIr(definition, types, analysis), language, await workflowCallees(definition, engine))
      } catch (error: unknown) {
        if (error instanceof RenderError) throw new Error(describeRenderFault(error.fault))
        throw error
      }
      return { name: args.name, language: language.name, source, warnings: warningsOf(analysis) }
    },
  })), 'workflow-tools:describe_workflow')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'run_workflow',
    description: '按名称启动一个已定义的工作流执行，返回运行 ID；用 get_workflow_run 查询进度和结果。',
    parameters: {
      name: { type: 'string', required: true, description: '要运行的工作流名称' },
      inputs: {
        type: 'json',
        description: '工作流声明输入端口的值，JSON 对象；省略的端口使用声明的默认值。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '运行 ID' },
          status: { type: 'string', description: '运行状态' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `工作流运行已启动 (runId: ${value.runId}, 状态: ${value.status})` },
      ],
    },
    async execute(args, _exec) {
      const summary = engine.findByName(args.name)
      if (summary === undefined) {
        throw new Error(`工作流 "${args.name}" 未找到`)
      }
      const run = engine.start(summary.id, workflowInputValues(args.inputs))
      return { runId: run.runId, status: 'running' }
    },
  })), 'workflow-tools:run_workflow')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_workflow_run',
    description: '按运行 ID 查询工作流运行的状态和每个节点的状态。',
    parameters: {
      runId: { type: 'string', required: true, description: 'run_workflow 返回的运行 ID' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '运行 ID' },
          name: { type: 'string', description: '工作流名称' },
          status: { type: 'string', description: '运行状态' },
          error: { type: 'string', description: '失败、取消或中断原因' },
          outputs: { type: 'json', description: '工作流声明输出端口收到的值' },
          nodes: {
            type: 'array',
            description: '节点状态',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                status: { type: 'string' },
                attempts: { type: 'number' },
                error: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `工作流 "${value.name}" 运行 ${value.runId}: ${value.status}${value.error === undefined ? '' : ` (${value.error})`}` },
      ],
    },
    async execute(args, _exec) {
      const result = engine.getRun(RunId(args.runId))
      if (result === undefined) throw new Error(`运行 ${args.runId} 不存在`)
      return {
        runId: result.runId,
        name: result.definition.name,
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.outputs === undefined ? {} : { outputs: toJsonObject(result.outputs, 'outputs') }),
        nodes: result.nodes.map(record => ({
          nodeId: record.nodeId,
          status: record.status,
          attempts: record.attempts,
          ...(record.error === undefined ? {} : { error: record.error }),
        })),
      }
    },
  })), 'workflow-tools:get_workflow_run')
}

/**
 * 工具参数中的工作流输入值。
 *
 * 工具参数来自模型，因此在这里校验，而不是相信声明的类型。
 * @param value - `inputs` 参数的原始值。
 * @returns 每个输入端口一个值；参数缺省时为空对象。
 * @throws 参数存在但不是 JSON 对象时。
 */
function workflowInputValues(value: unknown): JsonObject {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('inputs 必须是 JSON 对象')
  }
  return toJsonObject(value as Record<string, unknown>, 'inputs')
}
