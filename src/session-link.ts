/**
 * 把模型启动的运行挂到调用它的 Session 上。
 *
 * 运行作为该 Session 的一个后台作业：节点的进展写进作业输出，运行结束时作业结算，作业控制器据此向 Session 发出完成
 * 通知，模型不必轮询。运行等待的提问在该 Session 的对话中向用户提出，回答直接送达运行；在运行标签页回答同样有效，
 * 先到的答案生效。作业只是链接：停止作业或关闭 Session 只停止跟随，运行照常继续，仍可在运行标签页查看和控制。
 * @module dsh-workflow-studio
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle, JobHooks, JobId, JobOutcome, JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { DagEngine, DagRun } from './engine.ts'
import { messageOf } from './shared/errors.ts'
import { requestQuestions } from './shared/questions.ts'
import { NodeId, type DagRunInfo, type JsonObject, type WorkflowId, type WorkflowRunRecord } from './shared/types.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'workflow-run': 'workflow-run'
  }
}

/** The agent a tool call runs for. */
type CallingAgent = NonNullable<ToolExecution['agent']>

/** A run started as a job of the calling Session. */
export interface LinkedRun {
  readonly run: DagRun
  readonly jobId: JobId
}

/**
 * Start a run as a background job of the calling Session.
 * @param ctx - Plugin context; reads the optional `jobs` and `userQuestions` services.
 * @param engine - The workflow engine.
 * @param workflowId - The saved workflow to run.
 * @param inputs - Values for its declared inputs.
 * @param agent - The calling agent, which owns the job.
 * @param toolCall - The `run_workflow` call that creates the job.
 * @returns The run and its job; undefined when the composition cannot run jobs for this Session, in which case nothing
 * was started and the caller starts the run on its own.
 * @throws The engine's refusal to start the run, such as a missing input.
 */
export function startLinkedRun(
  ctx: Context,
  engine: DagEngine,
  workflowId: WorkflowId,
  inputs: JsonObject,
  agent: CallingAgent,
  toolCall: JobToolCall,
): LinkedRun | undefined {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return undefined
  let run: DagRun | undefined
  let starting = false
  try {
    const jobId = jobs.start({
      kind: 'workflow-run',
      label: engine.get(workflowId)?.name ?? workflowId,
      owner: agent.id,
      toolCall,
      run: (job) => {
        starting = true
        run = engine.start(workflowId, inputs)
        return follow(ctx, engine, run, job, agent)
      },
    })
    return { run: run!, jobId }
  } catch (error: unknown) {
    // A failure before the starter ran is the registry's preflight, such as no job controller serving this Session.
    if (!starting) return undefined
    throw error
  }
}

/** Report one run through its job until the run ends or the job stops following it. */
function follow(ctx: Context, engine: DagEngine, run: DagRun, job: JobHandle, agent: CallingAgent): JobHooks {
  const detached = new AbortController()
  const asking = new Map<string, AbortController>()
  const total = engine.getRun(run.runId)?.nodes.length ?? 0
  let ended = 0
  const ours = (info: DagRunInfo): boolean => info.runId === run.runId
  const key = (nodeId: string, requestId: string): string => `${nodeId}\u0000${requestId}`

  /** Ask a waiting `questions` request in the Session, and deliver the answer to the run. */
  const ask = async (nodeId: string, requestId: string): Promise<void> => {
    const request = engine.getRun(run.runId)?.nodes.find(node => node.nodeId === nodeId)?.requests
      ?.find(item => item.id === requestId)?.request
    const questions = request === undefined ? undefined : requestQuestions(request)
    const service = ctx.get('userQuestions')
    if (questions === undefined || service === undefined) return
    const asked = new AbortController()
    asking.set(key(nodeId, requestId), asked)
    try {
      const answer = await service.ask({ agent, questions, signal: AbortSignal.any([asked.signal, detached.signal]) })
      await engine.signal(run.runId, NodeId(nodeId), requestId, answer)
    } catch (error: unknown) {
      if (!asked.signal.aborted && !detached.signal.aborted) {
        job.append(`could not ask request ${requestId} in this Session: ${messageOf(error)}; answer it in the Runs tab\n`)
      }
    } finally {
      asking.delete(key(nodeId, requestId))
    }
  }

  const disposers = [
    ctx.on('dag/node-end', (info, node) => {
      if (!ours(info)) return
      ended += 1
      job.append(`${node.label} (${node.nodeId}): ${node.status}\n`)
      job.updateProgress(`${ended}/${total} nodes ended`)
    }),
    ctx.on('dag/signal-requested', (info, node, requestId) => {
      if (!ours(info)) return
      job.append(`${node.label} (${node.nodeId}) waits for an answer to request ${requestId}\n`)
      void ask(node.nodeId, requestId)
    }),
    ctx.on('dag/signal-received', (info, nodeId, requestId) => {
      if (!ours(info)) return
      // Answered here or in the Runs tab: a question still open in the Session has nothing left to ask.
      asking.get(key(nodeId, requestId))?.abort()
      job.append(`request ${requestId} of ${nodeId} answered\n`)
    }),
    ctx.on('dag/interrupted', (info, reason) => {
      if (ours(info)) job.append(`run interrupted: ${reason}; resume it in the Runs tab\n`)
    }),
  ]

  const done = Promise.race([
    run.result.then(outcomeOf),
    new Promise<JobOutcome>((resolve) => {
      detached.signal.addEventListener('abort', () => {
        resolve({ status: 'killed', detail: 'stopped following the run; it continues in the Runs tab' })
      }, { once: true })
    }),
  ]).finally(() => {
    for (const dispose of disposers) dispose()
    detached.abort()
  })
  return { cancel: () => { detached.abort() }, done }
}

/** How a run's end reads as a job outcome; a completed run's outputs are the job's result. */
function outcomeOf(record: WorkflowRunRecord): JobOutcome {
  switch (record.status) {
    case 'completed':
      return { status: 'completed', result: JSON.stringify(record.outputs ?? {}) }
    case 'cancelled':
      return { status: 'killed', detail: record.error ?? 'run cancelled' }
    default:
      return { status: 'failed', detail: record.error ?? `run ended ${record.status}` }
  }
}
