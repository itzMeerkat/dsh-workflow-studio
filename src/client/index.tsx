/**
 * Browser workflow editor and sidebar registration.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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

const PANEL_ID = 'dsh-workflow-studio' as MainPanelId

/** Browser services required before the editor mounts its Remote and slots. */
export const inject = ['slots', 'locale', 'remote']

/** What the panel receives from the slot: the dictionary, the Host Remote, and the renderer of waiting requests. */
type PanelProps = PropsLocale<typeof NS> & PropsRenderSlots<'workflowStudio.request'> & {
  remote: WorkflowStudioRemoteNamespace
}

/** The editor of both workflow kinds; a run workflow's Runs view renders waiting requests through the child slot. */
function WorkflowPanel({ renderSlot, ...props }: PanelProps) {
  return <WorkflowStudioPanel {...props} renderRequest={renderSlot} />
}

function WorkflowStudioIcon() {
  return <IconBranchOutlineRegular size={16} />
}

/** Register the workflow editor and its Remote namespace. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'workflow-studio:dictionaries',
  )
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => {
      const remote = ctx.get('remote.workflowStudio') as WorkflowStudioRemoteNamespace | undefined
      if (remote === undefined) throw new Error('workflowStudio Remote is not mounted')
      return { remote } as PanelProps
    },
    children: {
      'workflowStudio.request': { kind: 'keyed', scope: 'root' },
    },
  }, WorkflowPanel))
  ctx.slots.inject('workflowStudio.request', () => ctx.slots.register(
    { name: 'workflowStudio.request', key: QUESTIONS_KIND, locale: NS },
    QuestionsRequestForm,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 80,
    label: () => t('tab.editor'),
    locale: NS,
  }, WorkflowStudioIcon))

  return ctx.remote.$mount(workflowStudioRemote)
}
