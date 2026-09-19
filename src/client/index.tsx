/**
 * Browser workflow editor and sidebar registration.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS, dictionaries } from './locale.ts'
import workflowStudioRemote, { type WorkflowStudioRemoteNamespace } from './remote.ts'
import { WorkflowStudioPanel } from './WorkflowStudioPanel.tsx'

const PANEL_ID = 'dsh-workflow-studio' as MainPanelId

/** Browser services required before the editor mounts its Remote and slots. */
export const inject = ['slots', 'locale', 'remote']

function WorkflowStudioIcon() {
  return <IconBranchOutline16 size={16} />
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
      return { remote }
    },
  }, WorkflowStudioPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 80,
    label: () => t('tab.editor'),
    locale: NS,
  }, WorkflowStudioIcon))

  return ctx.remote.$mount(workflowStudioRemote)
}
