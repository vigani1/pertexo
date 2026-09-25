import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  WorkflowHubBar,
  type WorkflowHubTab,
} from '@/features/workflows/hub.public';
import { workflowSummaryQueryOptions } from '@/features/workflows/queries.public';
import { useWorkflowHubScope } from './workflow-hub-scope';

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
  const { apiClient, user, workspace, workflowId } = useWorkflowHubScope();
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, user.id, workspace.id, workflowId),
  );
  return (
    <>
      <div className="sticky top-0 z-30 px-3 pt-3">
        <WorkflowHubBar
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          workflowId={workflowId}
          workflow={summary.data}
          activeTab={tab}
          {...(actions === undefined ? {} : { actions })}
        />
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-16 sm:px-6">
        {children}
      </div>
    </>
  );
}
