/**
 * 错误策略：哪些节点能失败，以及节点上保存的策略。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NO_CALLEES } from '../src/shared/callees.ts'
import { canFail, errorPolicyOf } from '../src/shared/error-policy.ts'
import { ATOM_FIELD, CODE_ATOM_TYPE, GO, atomLibrary } from '../src/shared/language.ts'
import { NodeId } from '../src/shared/types.ts'
import { WORKFLOW_INPUT_TYPE } from '../src/shared/workflow-boundary.ts'
import { workflowDefinitionSchema } from '../src/shared/workflow-schema.ts'

const node = (type: string, config: Record<string, unknown> = {}) => ({ id: NodeId('n'), type, config })

describe('错误策略', () => {
  it('run 工作流中边界节点之外的节点都能失败；code 工作流中只有调用返回错误的函数的节点能失败', () => {
    assert.equal(canFail(node('value'), 'run', NO_CALLEES), true)
    assert.equal(canFail(node(WORKFLOW_INPUT_TYPE), 'run', NO_CALLEES), false)

    const atoms = atomLibrary('/shop', [
      { file: 'fetch.go', text: 'package p\n\nfunc Fetch(id string) (name string, err error) { return "", nil }\n' },
      { file: 'trim.go', text: 'package p\n\nfunc Trim(s string) string { return s }\n' },
    ], GO.functions.atoms).atoms
    const callees = { ...NO_CALLEES, atoms }
    assert.equal(canFail(node(CODE_ATOM_TYPE, { [ATOM_FIELD]: 'fetch.go' }), 'code', callees), true)
    assert.equal(canFail(node(CODE_ATOM_TYPE, { [ATOM_FIELD]: 'trim.go' }), 'code', callees), false)
    assert.equal(canFail(node('code-block'), 'code', callees), false)
  })

  it('未指定的策略是 exit；保存的定义只接受已知的策略', () => {
    assert.equal(errorPolicyOf(node('value')), 'exit')
    const definition = (onError: string) => ({ name: 'w', kind: 'run', nodes: [{ ...node('value'), onError }], edges: [] })
    assert.equal(workflowDefinitionSchema.parse(definition('exit')).nodes[0]?.onError, 'exit')
    assert.throws(() => workflowDefinitionSchema.parse(definition('retry')))
  })
})
