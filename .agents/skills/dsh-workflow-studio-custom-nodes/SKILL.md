---
name: "dsh-workflow-studio-custom-nodes"
description: "Create and register custom Workflow Studio node executors with ports, controls, lifecycle ownership, cancellation, and tests. Invoke when adding or changing a workflow node type."
---

# Workflow Studio Custom Nodes

Use this skill to add or change a Workflow Studio node. It is an implementation workflow, not a replacement for the current [executor types](../../../src/types.ts), [base class](../../../src/node.ts), [registry](../../../src/registry.ts), or package [README](../../../README.md).

## Define the node contract

Extend `WorkflowNode` from [`src/node.ts`](../../../src/node.ts) unless the node needs full control of `execute()`. Decide these members before writing `run()`:

- `type`: globally unique lowercase kebab-case identifier.
- `label` and `description`: concise user-visible catalog text.
- `ports`: business `inputs` and `outputs` with exact names, types, requiredness, descriptions, and card display modes. Do not declare an input named `condition`; the base class owns it.
- `controls`: optional browser controls backed by fields in `context.config`.
- `conditional`: leave it `true` for a normal node. Set it to `false` only for a flow-control node that computes branch signals and must not be gated by one.
- `variadicInputs`: declare the minimum instance input count and optional same-type output requirement.
- `requiresHumanInput`: use only when every execution of this node requires an external `DagRun.resume()`.

## Implement a node

Treat `context.config` and `context.inputs` as runtime JSON. Validate values that `run()` relies on. Return the outputs, or throw `NodeFailure` for an expected business failure; any other thrown error also fails the node, with its message.

```ts
import {
  NodeFailure,
  WorkflowNode,
  type NodeControlDefinition,
  type NodeExecutionContext,
  type WorkflowNodePorts,
} from 'dsh-workflow-studio'

export class PrefixTextNode extends WorkflowNode<{ output: string }> {
  readonly type = 'prefix-text'
  readonly label = 'Prefix text'
  readonly description = 'Prepends configured text to one string input'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'input', type: 'string', description: 'Text to transform' }],
    outputs: [{ name: 'output', type: 'string', description: 'Prefixed text', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'prefix',
    label: 'Prefix',
    kind: 'text',
    defaultValue: '',
  }]

  protected run(context: NodeExecutionContext): { output: string } {
    const input = context.inputs.input
    const prefix = context.config.prefix ?? ''
    if (typeof input !== 'string') throw new NodeFailure('input must be a string')
    if (typeof prefix !== 'string') throw new NodeFailure('prefix must be a string')
    return { output: `${prefix}${input}` }
  }
}
```

Every key in the returned outputs must match a declared output port. `NodeFailure` may carry diagnostic outputs but must provide an actionable message.

`context.inputs` contains only ports whose upstream produced a value, and `run()` never sees `condition`. Use `context.connected.has(name)` to distinguish a connected port whose upstream produced nothing from a disconnected port. `context.invocationKey` is `<runId>/<nodeId>`; use it to name or deduplicate external work when the node may run again.

A plain object that implements `WorkflowNodeExecutor` is also accepted. It returns the result union from `execute()` itself, may implement `preflight()`, and receives no condition input unless it declares one.

## Register with Cordis ownership

Declare the registry dependency and let a Cordis effect own the disposer returned by `register()`.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-workflow-studio'
import { PrefixTextNode } from './prefix-text.ts'

export const inject = ['workflowNodeRegistry']

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.workflowNodeRegistry.register(new PrefixTextNode(), 'my-workflow-nodes'),
    'my-workflow-nodes:prefix-text',
  )
}
```

Use the actual provider plugin name as `sourcePlugin`. It appears in the browser node catalog and must not be empty. The disposer may remove only its own registration; do not mutate registry internals.

## Port rules

- Omitted `required` means `true`.
- Use `required: false` only when the executor has defined behavior without that value.
- Port compatibility requires equal types unless one side uses `any`.
- An instance may override `inputs` or `outputs`; the engine validates the resulting ports when saving the workflow.
- One input port accepts at most one incoming edge.
- A `WorkflowNode` with `conditional` left `true` receives the optional boolean `condition` port. A connected condition that is `false` or produces nothing skips the node; a non-boolean value fails it.
- A control-flow node with `conditional: false` declares its own boolean branch outputs.
- An instance `inputs` override replaces the business inputs; the base class's `condition` port remains.

Use `display: 'value'` for compact scalar output and `display: 'json'` for structured output. Display metadata affects the card only; it does not validate runtime values.

## Variadic nodes

Set `variadicInputs.min` when each node instance may declare its own input list. All instance inputs must use one type. Set `outputType: 'same'` when the single output must use that type.

The executor receives only supplied input keys. Distinguish an absent key from a key whose value is `undefined` with `Object.hasOwn(context.inputs, name)` when that distinction changes behavior.

## Asynchronous work and cancellation

Observe `context.signal` throughout asynchronous work and stop promptly after abort. Remove timers, listeners, subprocesses, or other owned resources before settling. Do not convert an aborted operation into a completed output.

Use `context.log()` for concise run diagnostics at meaningful state transitions. Do not log credentials, full private payloads, or routine control flow.

## Add tests

Add focused tests beside the package tests or in the provider plugin that owns the node:

1. Exercise each successful business branch.
2. Reject malformed `config` and required input values.
3. Assert exact output port keys and values.
4. Exercise expected failed results.
5. For asynchronous nodes, abort while work is active and verify prompt teardown.
6. Register through a real `WorkflowNodeRegistry`; verify duplicate type rejection and disposer cleanup when registration behavior changes.
7. Save and run a small workflow through the real engine when the change affects ports, condition gating, variadic inputs, HITL, or scheduling.

Do not change production code only to make the executor testable. Prefer production configuration and real registry/engine integration over mocks.

## Final review

Before finishing, confirm:

- The type is kebab-case and unique.
- User-visible text is concise and locale ownership is respected for client changes.
- Every used input and produced output is declared.
- Expected invalid data throws `NodeFailure` (or returns `failed` from a plain executor) with a useful error.
- Async work observes cancellation and releases resources.
- Registration is effect-owned and names its source plugin.
- The browser catalog exposes the intended ports and controls.
- `pnpm test` and `pnpm build` pass from `dsh-workflow-studio`.
