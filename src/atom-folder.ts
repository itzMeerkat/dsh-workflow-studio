/**
 * Host 侧的原子目录：读出其中的原子，以及浏览器选择目录时看到的子目录。生成的工作流函数由 `workflow-files.ts` 写回目录。
 * @module dsh-workflow-studio
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { DagEngine } from './engine.ts'
import type { Callees } from './shared/callees.ts'
import { atomLibrary, isAtomFile, languageOf, type AtomFile, type AtomLibrary, type AtomSyntax } from './shared/language.ts'
import type { DagWorkflowDefinition, FolderListing } from './shared/types.ts'
import { messageOf } from './shared/errors.ts'
import { refuse } from './shared/refusal.ts'

/**
 * 一个目录中的原子文件和类型文件，不递归，按文件名排序。
 * @param folder - 目录的绝对路径。
 * @param syntax - 语言的原子读法。
 * @returns 每个文件的名字和全文。
 * @throws 路径不是绝对路径或目录读不出时。
 */
export async function readAtomFiles(folder: string, syntax: AtomSyntax): Promise<AtomFile[]> {
  if (!isAbsolute(folder)) refuse({ code: 'folder-relative', folder })
  const entries = await readFolder(folder)
  const files = entries
    .filter(entry => entry.isFile() && (isAtomFile(entry.name, syntax) || entry.name === syntax.types))
    .map(entry => entry.name)
    .sort()
  return Promise.all(files.map(async file => ({ file, text: await readFile(join(folder, file), 'utf8') })))
}

/**
 * 一个 `code` 工作流的原子库。
 * @param definition - 工作流定义。
 * @returns 它的原子目录读出的原子库；没有原子目录时为 undefined。
 */
export async function workflowAtoms(definition: DagWorkflowDefinition): Promise<AtomLibrary | undefined> {
  const syntax = languageOf(definition).functions?.atoms
  if (definition.atomFolder === undefined || syntax === undefined) return undefined
  return atomLibrary(definition.atomFolder, await readAtomFiles(definition.atomFolder, syntax), syntax)
}

/**
 * 一个工作流的节点能调用的一切：它原子目录中的原子，以及已保存的工作流。
 * @param definition - 工作流定义。
 * @param engine - 读取已保存的工作流。
 */
export async function workflowCallees(definition: DagWorkflowDefinition, engine: DagEngine): Promise<Callees> {
  const library = await workflowAtoms(definition)
  return {
    atoms: library?.atoms ?? new Map(),
    // list() 与 get() 同步读取同一张表，列出的 ID 一定存在。
    workflows: new Map(engine.list().map(summary => [summary.id, engine.get(summary.id)!])),
    ...(library === undefined ? {} : { package: library.package }),
  }
}

/**
 * 列出一层目录。
 * @param path - 目录的绝对路径；空字符串表示 Host 用户的主目录。
 * @returns 该目录、它的上一级、它的子目录和文件。
 * @throws 路径不是绝对路径或目录读不出时。
 */
export async function listFolders(path: string): Promise<FolderListing> {
  const folder = path === '' ? homedir() : path
  if (!isAbsolute(folder)) refuse({ code: 'folder-relative', folder })
  const entries = await readFolder(folder)
  const parent = dirname(folder)
  return {
    path: folder,
    ...(parent === folder ? {} : { parent }),
    folders: entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
      .map(name => ({ name, path: join(folder, name) })),
    files: entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name).sort(),
  }
}

/** 作者选错目录时操作系统给出的错误码：不存在、不是目录、没有权限。 */
const WRONG_FOLDER = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

/**
 * 一层目录的条目。
 * @throws 目录不存在、不是目录或没有权限时拒绝，因为作者能换一个目录；其他读取错误原样抛出。
 */
async function readFolder(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true })
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== undefined && WRONG_FOLDER.has(code)) refuse({ code: 'folder-unreadable', folder, reason: messageOf(error) })
    throw error
  }
}
