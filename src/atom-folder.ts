/**
 * Host 侧的原子目录：读出其中的原子，把生成的工作流函数写回目录，以及浏览器选择目录时看到的子目录。
 * @module dsh-workflow-studio
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { describeRenderFault } from './diagnostic-message.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import { analyzeWorkflow, indexNodeTypes } from './shared/analysis.ts'
import { validateWorkflow } from './validation.ts'
import { buildWorkflowIr } from './shared/ir.ts'
import { atomLibrary, isAtomFile, languageOf, type AtomFile, type AtomLibrary, type AtomSyntax } from './shared/language.ts'
import { RenderError, renderWorkflow } from './shared/source.ts'
import type { DagWorkflowDefinition, FolderListing } from './shared/types.ts'

/**
 * 一个目录中的原子文件和类型文件，不递归，按文件名排序。
 * @param folder - 目录的绝对路径。
 * @param syntax - 语言的原子读法。
 * @returns 每个文件的名字和全文。
 * @throws 路径不是绝对路径或目录读不出时。
 */
export async function readAtomFiles(folder: string, syntax: AtomSyntax): Promise<AtomFile[]> {
  if (!isAbsolute(folder)) throw new Error(`原子目录必须是绝对路径: ${folder}`)
  const entries = await readdir(folder, { withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && (isAtomFile(entry.name, syntax) || entry.name === syntax.types))
    .map(entry => entry.name)
    .sort()
  return Promise.all(files.map(async file => ({ file, text: await readFile(join(folder, file), 'utf8') })))
}

/**
 * 一个 `code` 工作流的原子库。
 * @param definition - 工作流定义。
 * @returns 它的原子目录中的原子；没有原子目录时为空。
 */
export async function workflowAtoms(definition: DagWorkflowDefinition): Promise<AtomLibrary> {
  const syntax = languageOf(definition).functions?.atoms
  if (definition.atomFolder === undefined || syntax === undefined) return { atoms: new Map(), faults: [], types: false }
  return atomLibrary(await readAtomFiles(definition.atomFolder, syntax), syntax)
}

/** 要写进原子目录的生成文件。 */
export interface WorkflowFile {
  readonly path: string
  readonly source: string
}

/**
 * 一个 `code` 工作流写进它原子目录的文件，与原子同属一个包。
 *
 * 保存前调用：写不出源码的工作流不保存，已保存的工作流就总有与之一致的文件。
 * @param definition - 待保存的工作流定义。
 * @param registry - 节点注册表，用于先按保存的规则校验定义。
 * @returns 文件的路径和内容；工作流没有原子目录时为 undefined。
 * @throws 定义不合法，或源码写不出时，说明要修改的节点。
 */
export async function workflowFile(
  definition: DagWorkflowDefinition,
  registry: WorkflowNodeRegistry,
): Promise<WorkflowFile | undefined> {
  const language = languageOf(definition)
  const syntax = language.functions?.atoms
  if (definition.atomFolder === undefined || syntax === undefined) return undefined
  validateWorkflow(registry, definition)
  const path = join(definition.atomFolder, syntax.output)
  const catalog = indexNodeTypes(registry.listTypes())
  const { atoms } = await workflowAtoms(definition)
  try {
    return { path, source: renderWorkflow(buildWorkflowIr(definition, catalog, analyzeWorkflow(definition, catalog)), language, atoms) }
  } catch (error: unknown) {
    if (error instanceof RenderError) throw new Error(`写不出 ${path}，工作流未保存：${describeRenderFault(error.fault)}`)
    throw error
  }
}

/**
 * 保存一个工作流，有原子目录时随后写出它的文件。
 * @param definition - 待保存的工作流定义。
 * @param registry - 节点注册表。
 * @param save - 引擎的保存或更新。
 * @returns 保存后的工作流 ID。
 */
export async function saveWithFile<T>(
  definition: DagWorkflowDefinition,
  registry: WorkflowNodeRegistry,
  save: () => Promise<T>,
): Promise<T> {
  const file = await workflowFile(definition, registry)
  const saved = await save()
  if (file !== undefined) await writeFile(file.path, file.source)
  return saved
}

/**
 * 列出一层目录。
 * @param path - 目录的绝对路径；空字符串表示 Host 用户的主目录。
 * @returns 该目录、它的上一级、它的子目录和文件。
 * @throws 路径不是绝对路径或目录读不出时。
 */
export async function listFolders(path: string): Promise<FolderListing> {
  const folder = path === '' ? homedir() : path
  if (!isAbsolute(folder)) throw new Error(`目录必须是绝对路径: ${folder}`)
  const entries = await readdir(folder, { withFileTypes: true })
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
