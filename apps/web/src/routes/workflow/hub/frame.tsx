import {
  WorkflowPresenceSummary,
  WorkflowPresenceWarning,
} from '@/features/workflow-collaboration/workflow-collaboration-views.public';
import type { ReactNode } from 'react';
import {
  WorkflowHubBar,
  type WorkflowHubTab,
} from '@/features/workflows/workflows-views.public';
import {
  WorkflowPausedBanner,
  WorkflowTriggerStatus,
} from '@/features/workflow-settings/workflow-settings-views.public';
import { useWorkflowHubScope } from './scope';

/** Layout for the scrolling hub tabs: the sticky bar, then the tab page. */
export function WorkflowHubTabFrame({
  tab,
  actions,
  children,
}: Readonly<{
  tab: WorkflowHubTab;
  actions?: ReactNode;
  children: ReactNode;
}>) {
  const { apiClient, user, workspace, workflowId, workflow } =
    useWorkflowHubScope();
  return (
    <>
      <div className="sticky top-0 z-30 px-3 pt-3">
        <WorkflowHubBar
          workflow={workflow}
          activeTab={tab}
          slots={{
            presence: <WorkflowPresenceSummary />,
            actions,
            renderStatus: (status) => (
              <WorkflowTriggerStatus
                apiClient={apiClient}
                userId={user.id}
                workspaceId={workspace.id}
                workflowId={workflowId}
              >
                {status}
              </WorkflowTriggerStatus>
            ),
          }}
          scope={{
            apiClient,
            userId: user.id,
            workspace,
            workflowId,
          }}
        />
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:px-6">
        <WorkflowPausedBanner
          key={`${user.id}:${workspace.id}:${workflowId}`}
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
          workflow={workflow}
          showReadError={tab !== 'settings'}
          showResume={tab !== 'settings'}
          problemSide="above"
        />
        <WorkflowPresenceWarning />
        {children}
      </div>
    </>
  );
}
