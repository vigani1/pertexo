import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceInboxFilter,
} from '@pertexo/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CheckCheckIcon, InboxIcon } from 'lucide-react';
import { LoadMore } from '@/components/patterns/load-more';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { ReadFailure } from '@/components/patterns/read-failure';
import { UnavailablePage } from '@/components/patterns/unavailable-page';
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ApiClient } from '@/lib/api/client';
import { isForbidden, isNotFound } from '@/lib/api/api-error-copy';
import { useNow } from '@/lib/use-now';
import { roleLimitSentence } from '@/features/workspaces/roles.public';
import { InboxThreadRow } from './components/inbox-thread-row';
import {
  useMarkAllReadMutation,
  useMarkThreadReadMutation,
} from './inbox.mutations';
import {
  inboxSummaryQueryOptions,
  inboxThreadsInfiniteQueryOptions,
} from './inbox.queries';

function InboxHeader({
  unreadCount,
  filter,
  canMarkAll,
  marking,
  onFilter,
  onMarkAll,
}: Readonly<{
  unreadCount: number | undefined;
  filter: WorkspaceInboxFilter;
  canMarkAll: boolean;
  marking: boolean;
  onFilter: (filter: WorkspaceInboxFilter) => void;
  onMarkAll: () => void;
}>) {
  return (
    <PageHeader>
      <div>
        <PageHeaderTitle>Inbox</PageHeaderTitle>
        {unreadCount === undefined ? null : (
          <PageHeaderMeta>
            <span>
              <b className="text-foreground">{unreadCount}</b> unread
            </span>
          </PageHeaderMeta>
        )}
      </div>
      <PageHeaderActions>
        <ToggleGroup
          aria-label="Show"
          value={[filter]}
          onValueChange={(values) => {
            const next: unknown = values[0];
            if (next === 'all' || next === 'unread') onFilter(next);
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="unread">Unread</ToggleGroupItem>
        </ToggleGroup>
        <ProgressButton
          type="button"
          variant="outline"
          size="sm"
          disabled={!canMarkAll}
          pending={marking}
          pendingLabel="Marking…"
          onClick={onMarkAll}
        >
          <CheckCheckIcon aria-hidden="true" data-icon="inline-start" />
          Mark all read
        </ProgressButton>
      </PageHeaderActions>
    </PageHeader>
  );
}

function InboxEmpty({ filter }: Readonly<{ filter: WorkspaceInboxFilter }>) {
  return (
    <Empty>
      <EmptyMedia>
        <InboxIcon aria-hidden="true" className="size-6" />
      </EmptyMedia>
      {filter === 'unread' ? (
        <>
          <EmptyTitle>You’re caught up</EmptyTitle>
          <EmptyDescription>
            Nothing has failed since you last looked. New failures show up here
            as they happen.
          </EmptyDescription>
        </>
      ) : (
        <>
          <EmptyTitle>No failing workflows</EmptyTitle>
          <EmptyDescription>
            When a run fails, times out or ends with an unknown outcome, its
            workflow shows up here for 30 days after its latest failure.
          </EmptyDescription>
        </>
      )}
    </Empty>
  );
}

function InboxSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="px-3 py-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </li>
      ))}
    </ul>
  );
}

/**
 * ADR 055: one notice per failing workflow, newest failure first, with this
 * person's own read state. Reading a notice never changes the run.
 */
export function InboxPage({
  apiClient,
  user,
  workspace,
  filter,
  onFilterChange,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  filter: WorkspaceInboxFilter;
  onFilterChange: (filter: WorkspaceInboxFilter) => void;
}>) {
  const canRead = workspace.capabilities.includes('notification:read');
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const threads = useInfiniteQuery({
    ...inboxThreadsInfiniteQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      filter,
    ),
    enabled: canRead,
  });
  const summary = useQuery({
    ...inboxSummaryQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const markRead = useMarkThreadReadMutation(scope);
  const markAll = useMarkAllReadMutation(scope);
  const nowMs = useNow(60_000);

  if (!canRead)
    return (
      <UnavailablePage
        heading="Inbox"
        title="The inbox is unavailable"
        description={roleLimitSentence(
          workspace.role,
          'notification:read',
          'get notified when workflows fail',
        )}
      />
    );
  if (
    threads.isError &&
    (isNotFound(threads.error) || isForbidden(threads.error))
  )
    return (
      <UnavailablePage
        heading="Inbox"
        title="The inbox is unavailable"
        description="This workspace’s inbox doesn’t exist, or you don’t have access to it."
      />
    );

  const items = threads.data?.pages.flatMap((page) => page.items) ?? [];
  // Mark-all reads what this list showed; later failures stay unread.
  const cut = threads.data?.pages[0]?.revision;
  const unreadCount = summary.data?.unreadCount;

  return (
    <div className="flex flex-col gap-8">
      <InboxHeader
        unreadCount={unreadCount}
        filter={filter}
        canMarkAll={cut !== undefined && (unreadCount ?? 0) > 0}
        marking={markAll.isPending}
        onFilter={onFilterChange}
        onMarkAll={() => {
          if (cut !== undefined) markAll.mutate(cut);
        }}
      />
      <p className="-mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Each workflow that failed, timed out or ended with an unknown outcome
        appears once, with how often it failed. Reading it here doesn’t change
        its runs.
      </p>
      {markRead.isError || markAll.isError ? (
        <Notice tone="destructive">
          That couldn’t be marked read. Nothing changed; try again.
        </Notice>
      ) : null}
      {threads.isError ? (
        <ReadFailure
          resource="The inbox"
          error={threads.error}
          showing={items.length > 0}
          retrying={threads.isRefetching}
          updatedAt={threads.dataUpdatedAt}
          onRetry={() => {
            void threads.refetch();
          }}
        />
      ) : null}
      {threads.isPending ? (
        <InboxSkeleton />
      ) : items.length === 0 ? (
        threads.isError ? null : (
          <InboxEmpty filter={filter} />
        )
      ) : (
        <ul aria-label="Failing workflows" className="flex flex-col">
          {items.map((thread) => (
            <InboxThreadRow
              key={thread.workflowId}
              workspaceId={workspace.id}
              thread={thread}
              nowMs={nowMs}
              marking={
                markRead.isPending &&
                markRead.variables.workflowId === thread.workflowId
              }
              onRead={() => {
                if (thread.unread)
                  markRead.mutate({
                    workflowId: thread.workflowId,
                    revision: thread.revision,
                  });
              }}
            />
          ))}
        </ul>
      )}
      <LoadMore
        subject="workflows"
        hasNextPage={threads.hasNextPage}
        loading={threads.isFetchingNextPage}
        failed={threads.isFetchNextPageError}
        onLoadMore={() => {
          void threads.fetchNextPage();
        }}
      />
    </div>
  );
}
