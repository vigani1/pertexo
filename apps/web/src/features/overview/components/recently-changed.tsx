import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { workflowRunVersionQueryOptions } from '@/features/workflow-runs/queries.public';
import { describeWorkflowState } from '@/features/workflows/hub.public';
import { recentWorkflowsQueryOptions } from '@/features/workflows/queries.public';
import { WorkflowGlyph } from '@/features/workflows/shape.public';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { HomeBlock } from './home-block';
import { queryBlockState } from '../model/home-block-state';

/**
 * The state in one word, then its version: "Live v7 · published 12 min ago",
 * or "Draft · never published". The live version is read by its ID, so the
 * number shows once that read lands.
 */
function VersionLine({
  apiClient,
  userId,
  workspaceId,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflow: WorkflowSummary;
}>) {
  const state = describeWorkflowState(workflow);
  const published = workflow.publishedVersionId;
  const version = useQuery({
    ...workflowRunVersionQueryOptions(
      apiClient,
      userId,
      workspaceId,
      workflow.id,
      published ?? '',
    ),
    enabled: published !== null,
  });
  const live = version.data;
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
      <Status tone={state.tone} className="shrink-0 text-[0.75rem] font-medium">
        {state.label}
      </Status>
      <span className="min-w-0 truncate font-mono text-[0.7rem] leading-none text-subtle-foreground">
        {published === null
          ? '· never published'
          : live === undefined
            ? null
            : `v${String(live.versionNumber)} · published ${formatRelativeTime(live.publishedAt)}`}
      </span>
    </p>
  );
}

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
          {workflows.map((workflow) => (
            <li
              key={workflow.id}
              className="grid grid-cols-[3.9rem_minmax(0,1fr)_auto] items-center gap-3 border-t border-white/6 py-3"
            >
              <WorkflowGlyph
                apiClient={apiClient}
                userId={userId}
                workspaceId={workspaceId}
                workflow={workflow}
              />
              <div className="min-w-0">
                <Link
                  to="/w/$workspaceId/workflows/$workflowId"
                  params={{ workspaceId, workflowId: workflow.id }}
                  className="block truncate text-sm font-semibold hover:text-accent-foreground"
                >
                  {workflow.name}
                </Link>
                <VersionLine
                  apiClient={apiClient}
                  userId={userId}
                  workspaceId={workspaceId}
                  workflow={workflow}
                />
              </div>
              <time
                dateTime={workflow.updatedAt}
                title={formatDateTime(workflow.updatedAt)}
                className="font-mono text-xs text-subtle-foreground"
              >
                {formatRelativeTime(workflow.updatedAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </HomeBlock>
  );
}
