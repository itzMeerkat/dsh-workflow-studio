# Split code into workflow atoms

Turn existing code into a `code` workflow: each piece of logic becomes one node (an "atom"), the graph wires the atoms together, and Workflow Studio writes the graph back out as one Go function. The graph then shows the program's data flow and branches, and anyone can rewire it in the Code Workflows panel.

## 1. Read the code and choose atoms

Read the whole function you are splitting, and every helper it calls. Then cut it along these lines:

- **One atom is one Go function** with a single purpose: it reads its parameters, computes, and returns its results. Parameters become the node's input ports and results become its output ports, so give results names (`(price float64, err error)`); unnamed results become ports `output`, or `output1`, `output2`… when there are several.
- **Pointer parameters and results are optional ports.** An unwired `*T` parameter receives `nil`, so make a dependency a pointer when the atom can run without it.
- **Every `if`/`else` in the original that chooses between work becomes a `branch` node.** Pull its condition out into an atom that returns `bool`, and put each side's work into its own atoms.
- **Keep loops, `switch`, early returns, `defer`, goroutines and error handling inside an atom.** The graph has no loops, and a branch only chooses between two sides. If a whole loop is one step of the algorithm, it is one atom.
- **An error that decides what happens next** is a result (`err error`) followed by an atom `func failed(err error) bool { return err != nil }` that feeds a `branch`.
- **Keep atoms small but meaningful.** A good atom is a step you would name in a code review ("compute subtotal", "apply coupon"). Do not make an atom for a single assignment; do not leave several steps in one atom when the graph should show a choice between them.

Write each atom as either a named function (`func subtotal(order Order) (amount float64) { … }`) or a function literal (`func(order Order) (amount float64) { … }`). Named functions keep their names in the output; a literal is bound to a variable named after the node. Methods (`func (s *Svc) …`) and type parameters are not supported: turn a method into a function that takes the receiver as its first parameter.

Types, imports and package-level declarations the atoms use are not part of the workflow. The generated file has no `package` line and no imports; list what the atoms need so the caller can place the output in a package that has them.

## 2. Build the graph

| Need | Node | How to wire it |
|---|---|---|
| A value the original function received | `workflow-input` (at most one) | Declare one entry in its `outputs` per parameter; wire each to the atoms that read it |
| A value the original function returned | `workflow-output` (at most one) | Declare one entry in its `inputs` per result, with `"required": false`; wire each from the atom or `merge` that produces it |
| A step | `code-function` | Put the Go function in `config.code`; ports are read from the signature when the workflow is saved, so do not write `inputs` or `outputs` yourself |
| A choice | `branch` | Wire a `bool` result to its `condition` input; draw `exec` edges from its `true` and `false` pins to the first atom of each side |
| Two sides meeting again | `merge` | Wire one result from each side into `input1` and `input2`, draw an `exec` edge from the last atom of each side into it, and read its `output` afterwards |

A data edge names its ports: `sourcePort` is the result name and `targetPort` the parameter name. Every atom on a `branch` side needs an `exec` edge from the atom before it on that side (the first one from the `branch` pin); a data edge alone does not put it on the side, and saving refuses a required parameter whose source may have been skipped. Values from both sides reach later atoms only through a `merge`.

Example — a checkout that discounts large orders:

```json
{
  "name": "checkout",
  "kind": "code",
  "language": "go",
  "nodes": [
    { "id": "in", "type": "workflow-input", "outputs": [{ "name": "order", "type": "any" }] },
    { "id": "subtotal", "type": "code-function", "config": { "code": "func subtotal(order Order) (amount float64) {\n\tfor _, line := range order.Lines {\n\t\tamount += line.Price * float64(line.Qty)\n\t}\n\treturn amount\n}" } },
    { "id": "over", "type": "code-function", "config": { "code": "func isLarge(amount float64) bool {\n\treturn amount > 100\n}" } },
    { "id": "gate", "type": "branch" },
    { "id": "cut", "type": "code-function", "config": { "code": "func discounted(amount float64, coupon *Coupon) (price float64) {\n\tprice = amount * 0.9\n\tif coupon != nil {\n\t\tprice -= coupon.Value\n\t}\n\treturn price\n}" } },
    { "id": "keep", "type": "code-function", "config": { "code": "func fullPrice(amount float64) (price float64) {\n\treturn amount\n}" } },
    { "id": "join", "type": "merge" },
    { "id": "out", "type": "workflow-output", "inputs": [{ "name": "price", "type": "number", "required": false }] }
  ],
  "edges": [
    { "id": "e1", "kind": "data", "source": "in", "sourcePort": "order", "target": "subtotal", "targetPort": "order" },
    { "id": "e2", "kind": "data", "source": "subtotal", "sourcePort": "amount", "target": "over", "targetPort": "amount" },
    { "id": "e3", "kind": "data", "source": "over", "sourcePort": "output", "target": "gate", "targetPort": "condition" },
    { "id": "e4", "kind": "exec", "source": "gate", "sourcePort": "true", "target": "cut" },
    { "id": "e5", "kind": "exec", "source": "gate", "sourcePort": "false", "target": "keep" },
    { "id": "e6", "kind": "data", "source": "subtotal", "sourcePort": "amount", "target": "cut", "targetPort": "amount" },
    { "id": "e7", "kind": "data", "source": "subtotal", "sourcePort": "amount", "target": "keep", "targetPort": "amount" },
    { "id": "e8", "kind": "data", "source": "cut", "sourcePort": "price", "target": "join", "targetPort": "input1" },
    { "id": "e9", "kind": "data", "source": "keep", "sourcePort": "price", "target": "join", "targetPort": "input2" },
    { "id": "e10", "kind": "exec", "source": "cut", "target": "join" },
    { "id": "e11", "kind": "exec", "source": "keep", "target": "join" },
    { "id": "e12", "kind": "data", "source": "join", "target": "out", "targetPort": "price" }
  ]
}
```

## 3. Save and check

Call `create_workflow` with the JSON above: `kind` is `code` and `language` is `go`. A refusal names the edge, port or node to fix.

Then call `describe_workflow` with the workflow name. It returns the generated Go and any warnings from the whole-graph analysis. For the example, the atoms come first at the top of the file, followed by:

```go
func checkout(order Order) (price float64) {
	var subtotal_amount float64
	var isLarge_output bool
	var join_output float64
	subtotal_amount = subtotal(order)
	isLarge_output = isLarge(subtotal_amount)
	if isLarge_output {
		join_output = discounted(subtotal_amount, nil)
	} else {
		join_output = fullPrice(subtotal_amount)
	}
	price = join_output
	return
}
```

Compare the generated function with the original: the same calls in the same order under the same conditions, and the same values returned. Fix the graph, not the output, and save again under the same name to replace it.

`describe_workflow` refuses to write the source, naming the node, when:

- a `code-function` holds code that does not start with a Go function (`not-a-function`);
- a non-pointer parameter has no incoming edge (`unwired-parameter`);
- a value is read from a `merge` that also collects something other than function results (`no-value`);
- a `branch` has nothing wired to `condition` (`no-condition`).

## 4. Report

Tell the user the workflow's name, the atoms you chose and why, what stayed inside an atom (loops, error handling) and anything the output needs from its package (types, imports). They can open it in the **Code Workflows** panel to see and rewire the graph.
