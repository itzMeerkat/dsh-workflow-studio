# Split code into workflow atoms

Turn existing Go code into a `code` workflow. Each step of the logic becomes an **atom**: one file in an atom folder, defining one function. The graph wires the atoms together, and saving the workflow writes the whole flow as one Go function, `workflow.go`, into the same folder. The graph then shows the program's data flow and branches, and anyone can rewire it in the Code Workflows panel.

## 1. Read the code and choose atoms

Read the whole function you are splitting, and every helper it calls. Then cut it along these lines:

- **One atom is one Go function** with a single purpose: it reads its parameters, computes, and returns its results. Parameters become the node's input ports and results become its output ports, so give results names (`(price float64, err error)`); unnamed results become ports `output`, or `output1`, `output2`… when there are several.
- **Pointer parameters and results are optional ports.** An unwired `*T` parameter receives `nil`, so make a dependency a pointer when the atom can run without it.
- **Every `if`/`else` in the original that chooses between work becomes a `branch` node.** Pull its condition out into an atom that returns `bool`, and put each side's work into its own atoms.
- **Keep loops, `switch`, early returns, `defer`, goroutines and error handling inside an atom.** The graph has no loops, and a branch only chooses between two sides. If a whole loop is one step of the algorithm, it is one atom.
- **An error that decides what happens next** is a result (`err error`) followed by an atom `func Failed(err error) bool { return err != nil }` that feeds a `branch`.
- **Keep atoms small but meaningful.** A good atom is a step you would name in a code review ("compute subtotal", "apply coupon"). Do not make an atom for a single assignment; do not leave several steps in one atom when the graph should show a choice between them.

## 2. Write the atom folder

The atom folder is one Go package on the Host: use the folder the user names, or create a new package directory for the workflow. Write each atom as its own `.go` file there:

- The file has the package clause, its own imports, and any package-level `var`, `const` and `type` declarations it needs (methods on those types are allowed).
- It defines **exactly one function**: `func Name(…) … { … }` or `var Name = func(…) … { … }`. A file with no function or with two is not an atom, so a helper goes inside the atom's function or becomes an atom of its own. Methods and type parameters cannot be atoms.
- Every file shares the package, so names must not clash across files, and no file may be called `workflow.go` (saving writes that file) or end in `_test.go` (those are not read).

For example, `discounted.go`:

```go
package checkout

import "math"

// Coupon takes a fixed amount off.
type Coupon struct {
	Value float64
}

func Discounted(amount float64, coupon *Coupon) (price float64) {
	price = amount * 0.9
	if coupon != nil {
		price -= coupon.Value
	}
	return math.Max(price, 0)
}
```

## 3. Build the graph

| Need | Node | How to wire it |
|---|---|---|
| A value the original function received | `workflow-input` (at most one) | Declare one entry in its `outputs` per parameter; wire each to the atoms that read it |
| A value the original function returned | `workflow-output` (at most one) | Declare one entry in its `inputs` per result, with `"required": false`; wire each from the atom or `merge` that produces it |
| A step | `code-atom` | Set `config.atom` to the atom's file name, such as `"discounted.go"`; ports are read from the function's signature when the workflow is saved, so do not write `inputs` or `outputs` yourself |
| A choice | `branch` | Wire a `bool` result to its `condition` input; draw `exec` edges from its `true` and `false` pins to the first atom of each side |
| Two sides meeting again | `merge` | Wire one result from each side into `input1` and `input2`, draw an `exec` edge from the last atom of each side into it, and read its `output` afterwards |

A data edge names its ports: `sourcePort` is the result name and `targetPort` the parameter name. Every atom on a `branch` side needs an `exec` edge from the atom before it on that side (the first one from the `branch` pin); a data edge alone does not put it on the side, and saving refuses a required parameter whose source may have been skipped. Values from both sides reach later atoms only through a `merge`.

Example — a checkout that discounts large orders, with atoms `subtotal.go`, `is_large.go`, `discounted.go` and `full_price.go`:

```json
{
  "name": "Checkout",
  "kind": "code",
  "language": "go",
  "atomFolder": "/home/me/shop/checkout",
  "nodes": [
    { "id": "in", "type": "workflow-input", "outputs": [{ "name": "order", "type": "any" }] },
    { "id": "subtotal", "type": "code-atom", "config": { "atom": "subtotal.go" } },
    { "id": "large", "type": "code-atom", "config": { "atom": "is_large.go" } },
    { "id": "gate", "type": "branch" },
    { "id": "cut", "type": "code-atom", "config": { "atom": "discounted.go" } },
    { "id": "keep", "type": "code-atom", "config": { "atom": "full_price.go" } },
    { "id": "join", "type": "merge" },
    { "id": "out", "type": "workflow-output", "inputs": [{ "name": "price", "type": "number", "required": false }] }
  ],
  "edges": [
    { "id": "e1", "kind": "data", "source": "in", "sourcePort": "order", "target": "subtotal", "targetPort": "order" },
    { "id": "e2", "kind": "data", "source": "subtotal", "sourcePort": "amount", "target": "large", "targetPort": "amount" },
    { "id": "e3", "kind": "data", "source": "large", "sourcePort": "output", "target": "gate", "targetPort": "condition" },
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

## 4. Save and check

Call `create_workflow` with that JSON: `kind` is `code`, `language` is `go`, and `atomFolder` is the folder's absolute path. Saving validates the graph, writes the workflow's function into the folder as `workflow.go`, and refuses to save a workflow whose function cannot be written, naming the edge, port or node to fix. For the example, `workflow.go` holds the package clause and:

```go
func Checkout(order Order) (price float64) {
	var Subtotal_amount float64
	var IsLarge_output bool
	var join_output float64
	Subtotal_amount = Subtotal(order)
	IsLarge_output = IsLarge(Subtotal_amount)
	if IsLarge_output {
		join_output = Discounted(Subtotal_amount, nil)
	} else {
		join_output = FullPrice(Subtotal_amount)
	}
	price = join_output
	return
}
```

The file imports only the packages its own function names (here none: `math` stays in `discounted.go`). Then:

1. Run `go vet` (or `go build`) in the folder. It compiles the atoms and `workflow.go` together, so a clash or a type mismatch between wired ports shows up here.
2. Compare the function with the original: the same calls in the same order under the same conditions, and the same values returned. Fix the graph or an atom, not `workflow.go`, and save again under the same name to rewrite it. `describe_workflow` returns the same source without writing it.

Saving refuses, naming the node, when:

- a `code-atom` names a file that is not in the atom folder, or is not an atom (`missing-atom`);
- a non-pointer parameter has no incoming edge;
- a value is read from a `merge` that also collects something other than atom results (`no-value`);
- a `branch` has nothing wired to `condition`.

## 5. Report

Tell the user the workflow's name, the atom files you wrote and why each is a separate step, what stayed inside an atom (loops, error handling), and whether `go vet` passed. They can open the workflow in the **Code Workflows** panel to see and rewire the graph.
