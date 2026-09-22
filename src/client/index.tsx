/**
 * Browser workflow editor and sidebar registration.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconBranchOutlineRegular, IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS, dictionaries } from './locale.ts'
import { QuestionsRequestForm } from './QuestionsRequestForm.tsx'
import { QUESTIONS_KIND } from '../shared/questions.ts'
import workflowStudioRemote, { type WorkflowStudioRemoteNamespace } from './remote.ts'
import { WorkflowStudioPanel } from './WorkflowStudioPanel.tsx'

const RUN_PANEL_ID = 'dsh-workflow-studio' as MainPanelId
const CODE_PANEL_ID = 'dsh-workflow-code' as MainPanelId

/** Browser services required before the editor mounts its Remote and slots. */
export const inject = ['slots', 'locale', 'remote']

/** What both panels receive from the slot: the dictionary and the Host Remote. */
interface PanelProps extends PropsLocale<typeof NS> {
  remote: WorkflowStudioRemoteNamespace
}

/** The run editor. It shows paused nodes' signal forms, so it declares that child slot. */
function RunWorkflowPanel({ renderSlot, ...props }: PanelProps & PropsRenderSlots<'workflowStudio.request'>) {
  return <WorkflowStudioPanel {...props} kind="run" renderRequest={renderSlot} />
}

/** The code editor. Code workflows compile instead of running, so it has no runs and no child slots. */
function CodeWorkflowPanel(props: PanelProps) {
  return <WorkflowStudioPanel {...props} kind="code" renderRequest={undefined} />
}

function WorkflowStudioIcon() {
  return <IconBranchOutlineRegular size={16} />
}

function WorkflowCodeIcon() {
  return <IconCodeOutlineRegular size={16} />
}

/** Register the workflow editor and its Remote namespace. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'workflow-studio:dictionaries',
  )
  const injectRemote = (): PanelProps => {
    const remote = ctx.get('remote.workflowStudio') as WorkflowStudioRemoteNamespace | undefined
    if (remote === undefined) throw new Error('workflowStudio Remote is not mounted')
    return { remote } as PanelProps
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: RUN_PANEL_ID,
    locale: NS,
    inject: injectRemote,
    children: {
      'workflowStudio.request': { kind: 'keyed', scope: 'root' },
    },
  }, RunWorkflowPanel))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: CODE_PANEL_ID,
    locale: NS,
    inject: injectRemote,
  }, CodeWorkflowPanel))
  ctx.slots.inject('workflowStudio.request', () => ctx.slots.register(
    { name: 'workflowStudio.request', key: QUESTIONS_KIND, locale: NS },
    QuestionsRequestForm,
  ))
  for (const [id, order, key, Icon] of [
    [RUN_PANEL_ID, 80, 'tab.editor', WorkflowStudioIcon],
    [CODE_PANEL_ID, 81, 'tab.code', WorkflowCodeIcon],
  ] as const) {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id,
      order,
      label: () => t(key),
      locale: NS,
    }, Icon))
  }

  return ctx.remote.$mount(workflowStudioRemote)
}
