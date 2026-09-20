---
description: "用于定义、持久化存储、校验和运行 DAG 工作流的 DeepSeek Harness 本地 bundle。"
kind: "package-bundle"
---

# dsh-workflow-studio

[English](README.md) | 中文

## 摘要

`dsh-workflow-studio` 为 DeepSeek Harness 增加持久化 DAG 定义存储、执行引擎、可扩展节点注册表、供节点作者使用的 `WorkflowNode` 基类、三个模型工具和浏览器图编辑器。每个工作流定义都保存在独立的 storage-domain 记录中，并在 Host 重启后恢复。每次运行都会写入独立记录的检查点，并在 Host 重启后继续，节点还可以等待运行之外的结果（例如人工回答），请求与结果随运行保存。

## 目录

- [安装](#install)
- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="install"></a>
## 安装

Workflow Studio 会添加一个 Web 面板，因此需要安装到包含 `@deepseek-ai/dsh-web-app` bundle 的 profile。`dsh plugin` 创建不存在的 profile 时只包含 `@deepseek-ai/dsh-base`，没有 Web UI；请先从 `web` 模板创建 profile。`--dump-config` 只创建 profile，不启动它：

```sh
dsh --profile <name> --from-default-profile web --dump-config
```

### 从 GitHub 安装

git 安装只获取源码。包的 `prepare` 脚本会运行 `pnpm build` 生成 `lib/`，profile 允许之前，pnpm 会拒绝运行该脚本。

1. 运行安装命令并固定一个 commit：

   ```sh
   dsh plugin --profile <name> add github:itzMeerkat/dsh-workflow-studio#<commit>
   ```

2. 第一次运行会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败。把错误信息中完整的 `allowBuilds` 键复制到 `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`（`$DSH_HOME` 默认为 `~/.dsh`）。该键包含包名、仓库 URL 和 commit；只写包名不会生效：

   ```yaml
   allowBuilds:
     "dsh-workflow-studio@git+https://github.com/itzMeerkat/dsh-workflow-studio.git#<commit>": true
   ```

3. 重新运行第 1 步的命令。然后确认组合后的配置包含 `# == dsh-workflow-studio` 层，再启动 profile：

   ```sh
   dsh --profile <name> --dump-config
   dsh --profile <name>
   ```

该许可允许此包的构建以你的用户权限在你的机器上、在 agent 沙箱之外运行。只允许你信任其源码的 commit。

更新时，用新的 commit 重复第 1–3 步；每个 commit 都需要单独的 `allowBuilds` 键。卸载时运行 `dsh plugin --profile <name> remove dsh-workflow-studio`，它会同时移除依赖和对应的 bundle 层。

### 从本地 checkout 安装

在 checkout 中运行 `pnpm install` 会执行 `prepare` 并构建 `lib/`。然后把 checkout 链接到 profile；链接的 checkout 不需要 `allowBuilds` 条目：

```sh
pnpm install
dsh plugin --profile <name> add /path/to/dsh-workflow-studio
```

profile 直接加载 checkout 的 `lib/`。修改源码后，运行 `pnpm build` 并重启 profile。

-----

<a id="use-this-package"></a>
## 使用此包

包内的 [`cordis.patch.yml`](cordis.patch.yml) 将 `dsh-workflow-studio` 插件插入 Harness profile。该插件不注册任何节点：节点由节点插件提供，例如单独的 `dsh-workflow-demo-node` 插件，其中包含 agent 提示词、人工审批和基础示例节点。新建的工作流为空。该插件依赖 `ctx.tools` 和 `ctx.storageDomain`，并提供 `ctx.workflowNodeRegistry` 和 `ctx.dagEngine`。基础 bundle 提供 JSON 后端并将 domain 路由到该后端。

模型可以使用三个工具：

| 工具 | 用途 |
|---|---|
| `create_workflow` | 校验并持久化保存一个具名工作流定义 |
| `run_workflow` | 按准确名称启动已保存的工作流并返回运行 ID |
| `get_workflow_run` | 报告运行状态以及每个节点的状态和调用次数 |

`create_workflow` 要求显式提供节点和边 ID。每个节点类型必须已经注册，每个引用端口必须存在，每个必填输入端口必须恰好有一条入边，可选输入可以不连接。连接的端口必须类型相同，除非其中一端使用 `any`。无效定义在进入引擎前就会失败。

每次运行都作为独立记录保存在 `workflow_studio_runs` storage domain 中，并附带运行启动时的定义快照；之后对工作流的修改不影响该运行。引擎在调用节点前写入节点的运行中状态，并且只在节点的结束状态写入后才视其完成。Host 停止时，未结束的运行保留最后保存的状态。下次启动且所有插件加载完成后，引擎会再次调用之前处于运行中的每个节点，从而提供至少一次调用语义，已完成的节点不会再次调用。已暂停的运行保持暂停。节点输出和 notepad 值必须是 JSON 值：值为 `undefined` 的输出端口视为未产生值，其他非 JSON 值会使节点失败。

| 配置字段 | 默认值 | 含义 |
|---|---|---|
| `autoRestart` | `true` | Host 启动时自动重新执行被中断的运行 |
| `retainRuns` | `100` | 保留的已结束运行数量；运行结束时删除更早的记录 |

当 `autoRestart` 为 `false`、被中断节点的恢复策略为 `hold`，或其某个节点类型未注册时，重启后恢复的运行会进入 `interrupted`，而不是重新执行。执行器声明 `recovery: 'rerun' | 'hold'`（默认 `rerun`），工作流定义中的节点可以用自身的 `recovery` 覆盖它。interrupted 运行在调用 `resumeRun()` 或 `resume` Remote 后继续，并再次调用未完成的节点。

不应重复已完成工作的节点可以使用 `context.invocationKey`（同一运行中该节点每次调用都相同）和 `context.notepad`。`await context.notepad.save(value)` 会把 JSON 值保存到运行记录中，重启后再次被调用的节点可从 `context.notepad.value` 读取它。

节点通过 `await context.awaitSignal(requestId, request)` 等待运行之外的结果，无论它来自人、外部作业还是另一个系统。`request` 是任意 JSON 值，引擎不读取其内容：请求被保存到节点的运行记录中，节点保持 `running`；`listRuns()` 以 `pendingRequests` 报告每个未结束运行中尚未送达结果的请求数量。`signal()` 或 `signal` Remote 保存结果并交给等待中的节点；运行处于 running、paused 或 interrupted 时都可以送达，重启后再次被调用的节点立即得到已保存的结果，尚无结果时继续等待原有请求。送达结果本身不会恢复运行，paused 或 interrupted 的运行仍需显式恢复。`requestId` 在重新调用之间必须保持不变，节点靠它找回自己的请求。

节点类型用可选的执行器成员 `validateSignal(request, result)` 校验结果格式。引擎在写入前调用它，因此格式错误在送达方一侧被拒绝，而不是使节点失败；未声明时接受任何 JSON 值。

向人提问只是其中一种请求格式，不是引擎的概念。`askUser(context, requestId, questions)` 以 `questions` 类型发起请求，问题与答案采用 `@deepseek-ai/dsh-user-questions` 中 Harness `ask_user_question` 工具的格式：每个问题可以提供选项、允许多选并接受自定义文本。`validateQuestionsSignal` 是与之配套的 `validateSignal`，运行标签页把这类请求渲染为表单。需要自有请求格式和界面的节点插件，在 `workflowStudio.request` 插槽中为自己的 `kind` 注册组件；没有组件的 `kind` 显示为原始请求内容。

要在某一步执行前要求人工批准，把等待批准的节点（例如 `dsh-workflow-demo-node` 的 `human-approval`）放在它前面。引擎自身没有确认步骤。

```json
{
  "name": "sum",
  "nodes": [
    { "id": "left", "type": "input", "config": { "defaultValue": 10 } },
    { "id": "right", "type": "input", "config": { "defaultValue": 20 } },
    { "id": "add", "type": "arithmetic", "config": { "operator": "add" } },
    { "id": "result", "type": "output", "config": {} }
  ],
  "edges": [
    { "id": "left-add", "kind": "data", "source": "left", "target": "add", "targetPort": "left" },
    { "id": "right-add", "kind": "data", "source": "right", "target": "add", "targetPort": "right" },
    { "id": "add-result", "kind": "data", "source": "add", "sourcePort": "result", "target": "result" }
  ]
}
```

第三方 Cordis 插件通过 `ctx.workflowNodeRegistry.register(executor, sourcePlugin)` 注册 `WorkflowNodeExecutor`。注册表按字段检查执行器，任何具备必需成员的对象都会被接受。必填的来源插件名会随每种节点类型显示在浏览器目录中，返回的 disposer 只移除该次注册。执行器声明连接端口、各输入是否必填、写入 `config` 的可选卡片控件，以及需要在卡片上渲染的输出。执行器返回 `{ status: 'completed', outputs, next? }` 或 `{ status: 'failed', error, outputs? }`；节点不能自行跳过，不适用时同样以 completed 结束且不做任何事。完成意味着每个已声明的输出端口都有值，无内容时写 `null`。自行选择执行引脚的节点（例如按人工决定分支的节点）直接实现 `execute`，而不继承 `WorkflowNode`。执行上下文包含 `connected`（有入边的输入端口）和 `invocationKey`（即 `<runId>/<nodeId>`）。节点作者通常继承 `WorkflowNode`，它要求声明 `type`、`label`、`description`、业务 `ports` 和 `run()`；`run()` 返回输出或抛出 `NodeFailure`。

每条边都要声明 `kind`。`data` 边把一个输出端口的值送到一个输入端口，`sourcePort` 和 `targetPort` 默认为 `output` 和 `input`。`exec` 边不传递数据，只约束执行顺序：目标节点在源节点完成后才执行，`sourcePort` 和 `targetPort` 默认为每个节点都有的 `then` 和 `run` 执行引脚。执行边用于表达数据依赖无法表达的顺序——两个节点写同一条外部记录、一项检查必须先于它所保护的工作被记录，或两个人工提问不能同时发出。没有入执行边的节点在运行到达时即执行；有入执行边的节点只在该边的源节点完成后执行，源节点被跳过时该边失效，目标节点不被调用而直接跳过，因此跳过沿执行边传递。数据边不传递这一信号。同一个节点的 `run` 引脚可以接入多条执行边，全部触发后节点才执行；而数据输入端口仍然只接受一条边。引擎会拒绝引用不存在引脚的执行边、同一对引脚之间的重复执行边，以及数据边与执行边共同构成的环。

分支节点通过 `execOutputs` 声明自己的执行引脚，并用返回值中的 `next` 选择本次触发哪些；声明引脚会替代 `then`，省略 `next` 时全部触发。引擎注册两种行为本身即执行语义的节点类型：`branch` 接收布尔 `condition` 并触发 `true` 或 `false` 之一；`merge` 是唯一的 OR 连接点——只要有一条入执行边触发它就执行，全部失效时才被跳过，并透传唯一送达的输入。其余节点一律是 AND 连接，因此无论走哪条分支都必须执行的节点应接在 `merge` 之后，而不是接在某一条分支之后。

因为跳过只沿执行边传递，一条通向必需输入、而源节点可能被跳过的数据边会让目标节点带着缺失的输入执行。引擎在保存工作流时拒绝这种接线，并指出该边和使源节点变为条件执行的引脚；补一条通向目标节点的执行边，或把输入端口声明为可选即可。

带 `variadicInputs` 的执行器允许每个工作流节点声明自己的 `inputs`：至少 `min` 个端口且类型相同；`outputType: 'same'` 时恰好有一个同类型输出。引擎在保存工作流时检查这些规则。

侧栏中的 **Workflow Studio** 面板用于打开编辑器。工具栏提供可搜索的工作流选择器、当前工作流名称编辑功能，以及可检索的节点菜单；节点菜单中的每一项都会标明来源插件。重命名并保存已有工作流时会保留其 ID，重复名称会被拒绝。React Flow 画布为每个已声明输入和输出渲染一个连接点，输入位于左侧，输出位于右侧，每张卡片还带有 `run` 和 `then` 执行引脚。执行引脚只能连接执行引脚；分支节点按其声明的引脚各渲染一个输出引脚；`run` 引脚接受所有连到它的边，只要没有两条重复同一对引脚。拖动连线时，连接预览会跟随指针；已有边的端点可以移动到另一个兼容端口，也可以拖到画布空白处删除。选中节点后，其详情和运行结果会在全宽画布下方展开。画布还支持节点定位、类型化端口连线、节点增删、卡片控件、卡片输出预览、JSON 配置编辑、坐标保存和运行状态覆盖。只读执行顺序视图使用按照调度器拓扑阶段排列的节点图替代原始 JSON 视图。它对数据依赖进行传递约简：如果另一条有向路径已经表示相同的执行顺序关系，就移除对应的直接边。执行边始终绘制，因为它由作者显式放置；由声明了多个引脚的节点引出的执行边标注所用的引脚名，例如 `true` 或 `false`。同一阶段的节点并发运行。运行列表会显示一次运行跳过了多少节点，因此悄悄走了分支的运行与全部执行的运行可以区分。保存和运行操作通过 Host 的 `workflowStudio` Remote 完成，解析和图校验仍由 Host 统一负责。

**运行** 会保存工作流、启动运行而不等待其结束，并打开 **运行** 标签页。该标签页列出当前工作流或全部工作流的运行，并分为 **进行中**（未结束或等待结果）和 **历史**。选中运行后可以看到其状态、开始时间、耗时和错误；适用时的 **暂停**、**恢复** 和 **取消运行**；每个等待中的请求，由为其 `kind` 注册的组件渲染；按运行时工作流快照绘制并标出节点状态的执行顺序图；以及节点状态、调用次数、输出和错误的表格。工具栏显示进行中的运行数量和等待结果的请求数量，点击任一数量会打开运行标签页。面板每两秒刷新一次运行状态；当选中的运行属于当前打开的工作流时，画布显示该运行的节点状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

`WorkflowNodeRegistry` 管理节点类型注册。`DagEngineProvider` 将已校验定义存入 `workflow_studio` domain，使用 Kahn 算法计算拓扑层，并并行执行每一层。该 domain 使用 `per-record` 布局，因此 JSON 后端会将每个 ID 写入 `<storage-root>/workflow_studio/workflows/<id>.json`。名称查找和写入共用一个引擎变更队列，因此并发保存同名工作流时会复用同一个 ID。节点失败后，引擎等待当前层结束，再将工作流标记为失败，并取消尚未启动的下游节点。

当上游输出对象包含选定 key 时，该输入端口存在。任何必需输入缺失都会使节点失败，并指出端口和本应产生它的节点——节点执行就意味着它断言必需数据存在。缺少可选输入不阻止执行。

`pauseRun()` 在拓扑层之间生效。`cancelRun()` 会中止运行，并结束所有暂停和所有等待中的 `awaitSignal()` 调用。执行器接收同一个 `AbortSignal`，在自身异步工作期间需要配合取消。`workflowStudio` Remote 按运行 ID 提供 `start`、`listRuns`、`getRun`、`pause`、`resume`、`cancel` 和 `signal`。

`get()` 返回的定义、`getRun()` 返回的运行记录和最终结果都是独立快照。调用方修改这些值不会改变引擎内部状态。

| 文件 | 职责 |
|---|---|
| [`src/registry.ts`](src/registry.ts) | 节点执行器注册表 |
| [`src/engine.ts`](src/engine.ts) | `ctx.dagEngine` 服务 API 和事件 |
| [`src/engine-provider.ts`](src/engine-provider.ts) | 定义存储、运行控制、结果送达、运行记录写入和恢复 |
| [`src/run-executor.ts`](src/run-executor.ts) | 按层级调度节点、暂停点、等待中的请求和节点结果 |
| [`src/validation.ts`](src/validation.ts) | 按注册表校验定义，以及拓扑顺序 |
| [`src/run-state.ts`](src/run-state.ts) | 运行的内存状态与运行记录转换 |
| [`src/persistence.ts`](src/persistence.ts) | 定义与运行的 per-record storage domain |
| [`src/node.ts`](src/node.ts) | `WorkflowNode` 基类和 `NodeFailure` |
| [`src/flow-nodes.ts`](src/flow-nodes.ts) | 引擎自有的 `branch`、`merge` 节点和 OR 连接判断 |
| [`src/shared/json.ts`](src/shared/json.ts) | 节点输出、notepad 值和信号负载的 JSON 检查 |
| [`src/shared/questions.ts`](src/shared/questions.ts) | `questions` 请求格式：`askUser`、答案校验和审批辅助函数 |
| [`src/tools.ts`](src/tools.ts) | 模型工具注册 |
| [`src/controller.ts`](src/controller.ts) | 浏览器快照、保存和运行控制所用的 Host Remote |
| [`src/shared/types.ts`](src/shared/types.ts) | Host 与浏览器共享的类型 |
| [`src/shared/workflow-schema.ts`](src/shared/workflow-schema.ts) | 定义、运行记录、运行摘要和编辑器快照的 JSON schema |
| [`src/shared/graph.ts`](src/shared/graph.ts) | 拓扑层级、端口兼容性和输入端口解析 |
| [`src/client/index.tsx`](src/client/index.tsx) | `main` 面板和侧边栏注册，以及 Remote 挂载 |
| [`src/client/locale.ts`](src/client/locale.ts) | `workflowStudio` 本地化命名空间的中英文文案 |
| [`src/client/remote.ts`](src/client/remote.ts) | Remote 方法描述和 `callRemote` 错误处理函数 |
| [`src/client/WorkflowStudioPanel.tsx`](src/client/WorkflowStudioPanel.tsx) | 工作流选择、保存、运行和画布/执行顺序/运行视图 |
| [`src/client/Menus.tsx`](src/client/Menus.tsx) | 工作流选择器和节点库菜单 |
| [`src/client/use-runs.ts`](src/client/use-runs.ts) | 运行列表轮询、运行选择、运行控制和结果送达 |
| [`src/client/ExecutionOrderView.tsx`](src/client/ExecutionOrderView.tsx) | 只读执行依赖图和运行状态 |
| [`src/client/WorkflowGraphEditor.tsx`](src/client/WorkflowGraphEditor.tsx) | React Flow 画布状态、节点编辑和连线 |
| [`src/client/graph-model.ts`](src/client/graph-model.ts) | 定义与画布节点和边之间的转换，以及连线规则 |
| [`src/client/NodeCard.tsx`](src/client/NodeCard.tsx) | 画布节点卡片：端口、内联控件和运行输出 |
| [`src/client/NodeInspector.tsx`](src/client/NodeInspector.tsx) | 所选节点的详情面板和运行结果 |
| [`src/client/model.ts`](src/client/model.ts) | 快照解析、节点摆放和执行计划 |
| [`src/client/RunsView.tsx`](src/client/RunsView.tsx) | 运行标签页：运行列表、控制按钮、问题表单和节点状态 |
| [`src/client/runs-model.ts`](src/client/runs-model.ts) | 运行记录解析、分组、等待中的请求和答案构建 |
| [`src/client/slot-contract.ts`](src/client/slot-contract.ts) | 节点插件用自有请求界面填充的 `workflowStudio.request` 插槽 |
| [`src/client/QuestionsRequestForm.tsx`](src/client/QuestionsRequestForm.tsx) | `questions` 请求的内置渲染组件 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`AGENTS.md`](AGENTS.md) 描述当前扩展和维护规则。
- [`dsh-workflow-studio-operations`](.agents/skills/dsh-workflow-studio-operations/SKILL.md) 指导工作流的创建、修改、执行和诊断。
- [`dsh-workflow-studio-custom-nodes`](.agents/skills/dsh-workflow-studio-custom-nodes/SKILL.md) 指导自定义节点的实现和注册。
- [`docs/architecture.zh.md`](../docs/architecture.zh.md) 描述 Harness 插件组合和应用启动方式。
- [`docs/subsystems/storage.zh.md`](../docs/subsystems/storage.zh.md) 描述持久化 domain 和后端路由。
- [`docs/cookbook/adding-a-tool.zh.md`](../docs/cookbook/adding-a-tool.zh.md) 描述模型工具注册与呈现。

-----

<a id="model-experience"></a>
## 模型体验

### 工具界面

模型会看到 `create_workflow`、`run_workflow` 和 `get_workflow_run` 的 schema 及其渲染结果。本包不添加系统提示词或运行时 Skill。

### Token 与缓存影响

三个工具 schema 会增加每个暴露全局工具集的请求。已保存定义和运行记录属于 Host 侧持久化数据；除非工具结果报告，否则两者都不会进入模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 定义会在 Host 重启后恢复，但 JSON 后端不提供跨进程写锁。
- 运行不会写入 Session 事件，`run_workflow` 启动的运行也不会关联到调用它的 Session。
- 节点只在 Host 重启后被再次调用；运行中的 Host 不会重试失败的节点。
- `start()` 不接受工作流级输入值。
- `PortDefinition.type` 用于控制边的兼容性，但引擎不执行通用运行时值类型校验。
- 等待中的请求可以在运行标签页、通过 `signal` Remote 或 `signal()` 送达结果；请求不会转发到 Harness 聊天 Session，内置问题表单会把所有问题（包括 `plan-review` 问题）渲染为通用选项列表。
- 执行器运行期间能否取消，取决于执行器是否观察 `context.signal`。
- 可视化编辑器尚未提供撤销/重做、复制/粘贴、分组、自动布局或多节点批量配置。

<a id="dev-note"></a>
### 开发说明

<details>
<summary>维护者工作上下文</summary>

在本目录运行 `pnpm test` 执行针对性 Node 测试，运行 `pnpm typecheck` 检查源码和测试的类型，运行 `pnpm build` 完成打包和声明生成。新的节点注册必须声明来源插件，由 Cordis effect 或返回的 disposer 管理，并准确声明工作流边使用的全部端口。

</details>
