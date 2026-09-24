import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { describeWorkflowState } from '@/features/workflows/hub.public';
import { recentWorkflowsQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { HomeBlock } from './home-block';
import { queryBlockState } from '../model/home-block-state';

/** The workflows whose lifecycle or publication changed most recently. */
export function RecentlyChanged({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
}>) {
  const recent = useQuery(
    recentWorkflowsQueryOptions(apiClient, userId, workspaceId),
  );
  const workflows = recent.data?.items ?? [];
  return (
    <HomeBlock
      title="Recently changed"
      headingId="home-recent-title"
      state={queryBlockState(recent)}
      actions={
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId }}
          className="text-xs text-subtle-foreground hover:text-foreground"
        >
          All workflows
        </Link>
      }
    >
      {workflows.length === 0 ? (
        <p className="border-t border-white/6 py-3.5 text-sm text-muted-foreground">
          No workflows yet. Create one from Workflows.
        </p>
      ) : (
        <ul aria-label="Recently changed workflows" className="flex flex-col">
          {workflows.map((workflow) => {
            const state = describeWorkflowState(workflow);
            return (
              <li
                key={workflow.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-white/6 py-3"
              >
                <div className="min-w-0">
                  <Link
                    to="/w/$workspaceId/workflows/$workflowId"
                    params={{ workspaceId, workflowId: workflow.id }}
                    className="block truncate text-sm font-semibold hover:text-accent-foreground"
                  >
                    {workflow.name}
                  </Link>
                  <Status
                    tone={state.tone}
                    className="mt-1 text-xs font-normal"
                  >
                    {state.label}
                  </Status>
                </div>
                <time
                  dateTime={workflow.updatedAt}
                  title={formatDateTime(workflow.updatedAt)}
                  className="font-mono text-xs text-subtle-foreground"
                >
                  {formatRelativeTime(workflow.updatedAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </HomeBlock>
  );
}
