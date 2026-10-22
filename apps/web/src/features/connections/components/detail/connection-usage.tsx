import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { SkeletonRows } from '@/components/ui/skeleton';
import { describeStep } from '@/features/catalog/presentation.public';
import type { ConnectionMutationScope } from '../../data/connections.mutations';
import { connectionUsageQueryOptions } from '../../data/connections.queries';
import type { ConnectionUsageResponse } from '@pertexo/contracts';

/** Retained published versions, not drafts or an inferred current graph. */
export function ConnectionUsage({
  scope,
  connectionId,
  canRead,
}: Readonly<{
  scope: ConnectionMutationScope;
  connectionId: string;
  canRead: boolean;
}>) {
  const usage = useInfiniteQuery({
    ...connectionUsageQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      connectionId,
    ),
    enabled: canRead,
  });
  const items = usage.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-label="Used by" className="flex flex-col gap-3">
      <div>
        <h3 className="font-semibold">Used by</h3>
        <p className="text-xs text-muted-foreground">
          Published versions that use it, including older ones runs still rely
          on. Drafts aren’t counted.
        </p>
      </div>
      {!canRead ? (
        <p className="text-sm text-muted-foreground">
          Workflow-read permission is needed to see usage.
        </p>
      ) : (
        <>
          {usage.isError && !usage.isFetchNextPageError ? (
            <ReadFailure
              resource="Connection usage"
              error={usage.error}
              showing={items.length > 0}
              updatedAt={usage.dataUpdatedAt}
              retrying={usage.isRefetching}
              onRetry={() => void usage.refetch()}
            />
          ) : null}
          {usage.isPending ? (
            <SkeletonRows label="Loading connection usage" />
          ) : null}
          {usage.isSuccess && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No retained published versions use this connection.
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {usedByWorkflow(items).map((workflow) => (
              <li key={workflow.workflowId} className="min-w-0 text-sm">
                <Link
                  to="/w/$workspaceId/workflows/$workflowId/settings"
                  params={{
                    workspaceId: scope.workspaceId,
                    workflowId: workflow.workflowId,
                  }}
                  className="block truncate rounded-sm text-action underline-offset-4 hover:underline focus-ring"
                >
                  {workflow.workflowName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {describeVersions(workflow)}
                </p>
                <p className="text-xs text-subtle-foreground">
                  {workflow.operationKeys
                    .map((key) => describeStep(key).name)
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
          <LoadMore
            subject="published versions"
            hasNextPage={usage.hasNextPage}
            loading={usage.isFetchingNextPage}
            failed={usage.isFetchNextPageError}
            onLoadMore={() => void usage.fetchNextPage()}
          />
        </>
      )}
    </section>
  );
}

type UsageItem = ConnectionUsageResponse['items'][number];
type WorkflowUsage = Readonly<{
  workflowId: string;
  workflowName: string;
  archived: boolean;
  current: number | undefined;
  older: number;
  operationKeys: readonly string[];
}>;

/** Runs keep older versions alive, so one workflow can appear many times; show it once. */
function usedByWorkflow(items: readonly UsageItem[]): readonly WorkflowUsage[] {
  const workflows = new Map<string, WorkflowUsage>();
  for (const item of items) {
    const known = workflows.get(item.workflowId);
    workflows.set(item.workflowId, {
      workflowId: item.workflowId,
      workflowName: item.workflowName,
      archived: item.workflowLifecycleStatus === 'archived',
      current: item.isCurrentPublication ? item.versionNumber : known?.current,
      older: (known?.older ?? 0) + (item.isCurrentPublication ? 0 : 1),
      operationKeys: [
        ...new Set([...(known?.operationKeys ?? []), ...item.operationKeys]),
      ],
    });
  }
  return [...workflows.values()];
}

function describeVersions(workflow: WorkflowUsage): string {
  const older =
    workflow.older === 0
      ? ''
      : `${String(workflow.older)} older ${workflow.older === 1 ? 'version' : 'versions'} still used by runs`;
  const live =
    workflow.current === undefined
      ? ''
      : `Live as version ${String(workflow.current)}`;
  const parts = [live, older].filter((part) => part !== '');
  return `${parts.join(', ')}${workflow.archived ? ' (archived workflow)' : ''}`;
}
