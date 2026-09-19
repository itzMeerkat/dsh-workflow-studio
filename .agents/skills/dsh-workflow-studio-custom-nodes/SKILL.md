---
name: "dsh-workflow-studio-custom-nodes"
description: "Create and register custom Workflow Studio node executors with ports, controls, lifecycle ownership, cancellation, and tests. Invoke when adding or changing a workflow node type."
---

# Workflow Studio Custom Nodes

Use this skill to add or change a `WorkflowNodeExecutor`. It is an implementation workflow, not a replacement for the current [executor types](../../../src/types.ts), [registry](../../../src/registry.ts), or package [README](../../../README.md).

## Define the node contract

Decide these fields before writing `execute()`:

- `type`: globally unique lowercase kebab-case identifier.
- `label` and `description`: concise user-visible catalog text.
- `inputs` and `outputs`: exact port names, types, requiredness, descriptions, and card display modes.
- `controls`: optional browser controls backed by fields in `context.config`.
- `acceptsCondition`: omit for a normal node; use `false` only when the node implements flow control and must not receive engine gating.
- `variadicInputs`: declare the minimum instance input count and optional same-type output requirement.
- `requiresHumanInput`: use only when every execution of this node requires an external `DagRun.resume()`.

Do not declare an input named `condition` on a normal node. The engine reserves and adds that port.

## Implement an executor

Treat `context.config` and `context.inputs` as runtime JSON. Validate values that the executor relies on, then return the discriminated result instead of throwing for expected business failures.

```ts
import type {
  NodeExecutionResult,
  WorkflowNodeExecutor,
} from 'dsh-workflow-studio'

export const prefixTextNode: WorkflowNodeExecutor = {
  type: 'prefix-text',
  label: 'Prefix text',
  description: 'Prepends configured text to one string input',
  inputs: [
    { name: 'input', type: 'string', description: 'Text to transform' },
  ],
  outputs: [
    { name: 'output', type: 'string', description: 'Prefixed text', display: 'value' },
  ],
  controls: [{
    name: 'prefix',
    label: 'Prefix',
    kind: 'text',
    defaultValue: '',
  }],
  execute(context): NodeExecutionResult {
    const input = context.inputs.input
    const prefix = context.config.prefix ?? ''
    if (typeof input !== 'string') {
      return { status: 'failed', error: 'input must be a string' }
    }
    if (typeof prefix !== 'string') {
      return { status: 'failed', error: 'prefix must be a string' }
    }
    return { status: 'completed', outputs: { output: `${prefix}${input}` } }
  },
}
```

Every key in a completed `outputs` object must match a declared output port. A failed result may include diagnostic outputs but must provide an actionable `error`.

## Register with Cordis ownership

Declare the registry dependency and let a Cordis effect own the disposer returned by `register()`.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-workflow-studio'
import { prefixTextNode } from './prefix-text.ts'

export const inject = ['workflowNodeRegistry']

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.workflowNodeRegistry.register(prefixTextNode, 'my-workflow-nodes'),
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
- A normal node receives the optional boolean `condition` port automatically.
- A control-flow node with `acceptsCondition: false` declares its own boolean branch outputs.

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
- Expected invalid data returns `failed` with a useful error.
- Async work observes cancellation and releases resources.
- Registration is effect-owned and names its source plugin.
- The browser catalog exposes the intended ports and controls.
- `pnpm test` and `pnpm build` pass from `dsh-workflow-studio`.
