/**
 * Host 侧原子目录：读出原子文件，列出供选择的子目录。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFolders, readAtomFiles, workflowAtoms } from '../src/atom-folder.ts'
import { GO } from '../src/shared/language.ts'
import { workflow } from './graph-fixtures.ts'

describe('原子目录', () => {
  it('只读该语言的原子文件和 types.go，不含测试文件、生成的工作流文件和子目录；工作流读出其中的原子；子目录路径由 Host 拼接', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'atoms-'))
    try {
      await writeFile(join(folder, 'add.go'), 'package m\n\nfunc Add(a, b int) int { return a + b }\n')
      await writeFile(join(folder, 'add_test.go'), 'package m\n')
      await writeFile(join(folder, 'types.go'), 'package m\n\ntype Sum int\n')
      await writeFile(join(folder, 'workflow.go'), 'package m\n\nfunc flow() {}\n')
      await writeFile(join(folder, 'notes.md'), '# notes\n')
      await mkdir(join(folder, 'nested'))
      await mkdir(join(folder, '.git'))

      assert.deepEqual((await readAtomFiles(folder, GO.functions!.atoms)).map(file => file.file), ['add.go', 'types.go'])
      const library = await workflowAtoms(workflow({}, [], { kind: 'code', language: 'go', atomFolder: folder }))
      assert.deepEqual([...library.atoms.keys()], ['add.go'])
      assert.equal(library.types, true)
      assert.deepEqual(await listFolders(folder), {
        path: folder,
        parent: tmpdir(),
        folders: [{ name: 'nested', path: join(folder, 'nested') }],
        files: ['add.go', 'add_test.go', 'notes.md', 'types.go', 'workflow.go'],
      })
      await assert.rejects(readAtomFiles('relative/atoms', GO.functions!.atoms), /绝对路径/)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
