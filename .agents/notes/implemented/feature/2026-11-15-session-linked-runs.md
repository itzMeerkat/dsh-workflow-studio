# Agent Note: Runs that follow their Session

Status: implemented

## Problem

A run the model started with `run_workflow` was invisible to the conversation. The model had to call `get_workflow_run` repeatedly to learn that it ended, and a question the run asked a person appeared only in the Workflow Studio panel, where the user chatting with the model would not look. A run waiting days for an approval looked, from the chat, like nothing at all.

## Decision

When the composition loads background jobs and the call comes from an agent, `run_workflow` starts the run as a `workflow-run` job owned by the calling Session (`startLinkedRun` in `src/session-link.ts`). The Harness job registry and controller then supply everything a Session needs to follow long work, and Studio writes none of it:

- **Progress.** Each node's end, each request the run waits for, each answer, and an interruption are appended to the job's output, and the progress line counts ended nodes. `job_output` reads them.
- **Completion.** When the run ends the job settles: `completed` with the run's outputs as its result, `killed` for a cancelled run, `failed` otherwise. The job controller turns the settlement into a completion notice in the Session, and the jobs package records the job's lifecycle in the Session log, so what the model sees is logged.
- **Questions in the chat.** A `questions` request is asked through `ctx.userQuestions` with the calling agent, which shows an ordinary question card in that Session; the answer goes to the run through `signal()`. An answer given first in the Runs tab aborts the question in the chat, and a failed ask writes a line telling the model to answer in the Runs tab.

**The job is only a link.** Its `cancel` hook detaches: `job_kill`, the owning Session closing, and the Host stopping all end the following and leave the run running. Runs are durable and outlive both the Session and the Host, so the job must not decide their fate.

When no job registry is loaded, or the registry's preflight refuses the job, for example because no job controller serves the Session, nothing was started, and `run_workflow` starts the run on its own as before.

## Alternatives considered

**A Studio-specific Session event and notice.** Studio would record its own events and inject its own message when a run ends. It duplicates what the jobs seam already provides, including the logging rule for model-visible input, the notice delivery, and the `job_*` tools the model already knows.

**Cancelling the run when the job is killed.** It matches what `job_kill` does to a shell command. It also means that closing a chat, or a Host stop tearing down jobs, would cancel a durable run that may be waiting for an approval, and a cancelled run is never recovered. Cancelling stays an explicit act in the Runs tab or through the engine.

**Asking questions through the model.** The model could relay each question as `ask_user_question` and pass the answer back with a new tool. It spends a model turn per question and lets the model reword or answer it; asking the user directly keeps the question exact.

**Linking runs started from the panel too.** A run started in the panel has no calling Session; tying it to whichever chat is open would be a guess.

## Consequences

The link lasts as long as the Host that created it: after a restart the run continues but reports to no Session, because jobs are in-process. Only `questions` requests reach the chat; other request kinds are answered in the Runs tab. A followed run adds one completion notice, plus whatever `job_output` returns, to the Session's context. `@deepseek-ai/dsh-jobs` is a peer dependency for its types only; Studio reads `ctx.jobs` and `ctx.userQuestions` when a run starts and works without them.
