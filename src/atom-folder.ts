/**
 * Host 侧的原子目录：读出其中的原子，把生成的工作流函数写回目录，以及浏览器选择目录时看到的子目录。
 * @module dsh-workflow-studio
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { describeRenderFault } from './diagnostic-message.ts'
import type { DagEngine } from './engine.ts'
import type { WorkflowNodeRegistry } from './registry.ts'
import type { Callees } from './shared/callees.ts'
import { analyzeWorkflow, indexNodeTypes } from './shared/analysis.ts'
import { validateWorkflow } from './validation.ts'
import { buildWorkflowIr } from './shared/ir.ts'
import { atomLibrary, isAtomFile, languageOf, type AtomFile, type AtomLibrary, type AtomSyntax } from './shared/language.ts'
import { RenderError, renderWorkflow } from './shared/source.ts'
import type { DagWorkflowDefinition, FolderListing, WorkflowId } from './shared/types.ts'

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

/** 保存工作流时用到的 Host 服务。 */
export interface WorkflowHost {
  readonly registry: WorkflowNodeRegistry
  readonly engine: DagEngine
}

/**
 * 一个工作流的节点能调用的一切：它原子目录中的原子，以及已保存的工作流。
 * @param definition - 工作流定义。
 * @param engine - 读取已保存的工作流。
 */
export async function workflowCallees(definition: DagWorkflowDefinition, engine: DagEngine): Promise<Callees> {
  return {
    atoms: (await workflowAtoms(definition)).atoms,
    // list() 与 get() 同步读取同一张表，列出的 ID 一定存在。
    workflows: new Map(engine.list().map(summary => [summary.id, engine.get(summary.id)!])),
  }
}

/**
 * 一个工作流生成的文件在原子目录中的路径。
 * @param definition - 工作流定义。
 * @param id - 工作流 ID，也是文件名的主体。
 * @returns 路径；工作流没有原子目录时为 undefined。
 */
export function workflowFilePath(definition: DagWorkflowDefinition, id: WorkflowId): string | undefined {
  const syntax = languageOf(definition).functions?.atoms
  if (definition.atomFolder === undefined || syntax === undefined) return undefined
  return join(definition.atomFolder, `${id}${syntax.outputSuffix}`)
}

/**
 * 一个 `code` 工作流写进它原子目录的源码，与原子同属一个包。
 *
 * 保存前调用：写不出源码的工作流不保存，已保存的工作流就总有与之一致的文件。
 * @param definition - 待保存的工作流定义。
 * @param host - 按保存的规则校验定义，并提供能调用的工作流。
 * @returns 源码；工作流没有原子目录时为 undefined。
 * @throws 定义不合法，或源码写不出时，说明要修改的节点。
 */
export async function workflowSource(definition: DagWorkflowDefinition, host: WorkflowHost): Promise<string | undefined> {
  const language = languageOf(definition)
  if (definition.atomFolder === undefined || language.functions?.atoms === undefined) return undefined
  validateWorkflow(host.registry, definition)
  const catalog = indexNodeTypes(host.registry.listTypes())
  const callees = await workflowCallees(definition, host.engine)
  try {
    return renderWorkflow(buildWorkflowIr(definition, catalog, analyzeWorkflow(definition, catalog)), language, callees)
  } catch (error: unknown) {
    if (error instanceof RenderError) {
      throw new Error(`写不出工作流 "${definition.name}" 的源码，工作流未保存：${describeRenderFault(error.fault)}`)
    }
    throw error
  }
}

/**
 * 保存一个工作流，有原子目录时随后写出它的文件 `<ID><后缀>`。
 *
 * 替换已有工作流时，它原先的文件若不再是该工作流的文件（改了名或换了原子目录），就被删除。
 * @param definition - 待保存的工作流定义。
 * @param host - 节点注册表和引擎。
 * @param save - 引擎的保存或更新。
 * @param replaces - 被替换的工作流 ID；新建时省略。
 * @returns 保存后的工作流 ID。
 */
export async function saveWithFile(
  definition: DagWorkflowDefinition,
  host: WorkflowHost,
  save: () => Promise<WorkflowId>,
  replaces?: WorkflowId,
): Promise<WorkflowId> {
  const source = await workflowSource(definition, host)
  const previous = replaces === undefined ? undefined : { id: replaces, definition: host.engine.get(replaces) }
  const before = previous?.definition === undefined ? undefined : workflowFilePath(previous.definition, previous.id)
  const id = await save()
  const path = workflowFilePath(definition, id)
  // 源码和路径都只在工作流有原子目录时存在。
  if (source !== undefined) await writeFile(path!, source)
  if (before !== undefined && before !== path) await rm(before, { force: true })
  return id
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
