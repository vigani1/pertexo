import { NoticeKindFilter } from '../components/threads/kind-filter';
import type { ReactNode } from 'react';
import { FinishedThread } from '@/components/patterns/states/thread-illustrations';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkspaceInboxFilter,
  WorkspaceNoticeKind,
  WorkspaceInboxListResponse,
} from '@pertexo/contracts';
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { LoadMore } from '@/components/patterns/lists/load-more';
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { QueryView } from '@/components/patterns/states/query-view';
import { UnavailablePage } from '@/components/patterns/states/unavailable-page';
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ApiClient } from '@/lib/api/client';
import { isForbidden, isNotFound } from '@/lib/api/error-copy';
import { useNow } from '@/lib/hooks/use-now';
import { roleLimitSentence } from '@/features/workspaces/roles.public';
import { NoticeThreadRow } from '../components/threads/notice-row';
import {
  useMarkAllReadMutation,
  useMarkThreadReadMutation,
  type InboxScope,
} from '../data/inbox.mutations';
import {
  inboxSummaryQueryOptions,
  inboxThreadsInfiniteQueryOptions,
} from '../data/inbox.queries';

function InboxHeader({
  filter,
  canMarkAll,
  marking,
  views,
  kindFilter,
  onFilter,
  onMarkAll,
}: Readonly<{
  filter: WorkspaceInboxFilter;
  canMarkAll: boolean;
  marking: boolean;
  views?: ReactNode;
  kindFilter?: ReactNode;
  onFilter: (filter: WorkspaceInboxFilter) => void;
  onMarkAll: () => void;
}>) {
  return (
    <PageHeader>
      <div className="flex flex-col gap-4">
        {/* The unread count rides on the Notices view, so Notices and
            Requests share one header and switching never moves the page. */}
        <PageHeaderTitle>Inbox</PageHeaderTitle>
        {views}
      </div>
      <PageHeaderActions>
        {kindFilter}
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
          {/* An icon on a phone keeps the controls on one row. */}
          <span className="max-sm:sr-only">Mark all read</span>
        </ProgressButton>
      </PageHeaderActions>
    </PageHeader>
  );
}

function InboxEmpty({ filter }: Readonly<{ filter: WorkspaceInboxFilter }>) {
  return (
    <Empty>
      <EmptyMedia className="w-full max-w-56">
        <FinishedThread />
      </EmptyMedia>
      {filter === 'unread' ? (
        <>
          <EmptyTitle>You’re caught up</EmptyTitle>
          <EmptyDescription>
            Nothing needs your attention. New notices show up here as they
            happen.
          </EmptyDescription>
        </>
      ) : (
        <>
          <EmptyTitle>Everything finished</EmptyTitle>
          <EmptyDescription>
            No notices need your attention. Workflow failures, auto-paused
            workflows, connections, limits and waiting approvals appear here
            when they need a look.
          </EmptyDescription>
        </>
      )}
    </Empty>
  );
}

/** Notices loading in their own shape: a ring, a name and a thread. */
function InboxSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {[38, 52, 30].map((width, order) => (
        <li
          key={width}
          className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 px-3 py-4"
        >
          <span className="size-8 rounded-full border border-border" />
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-3" style={{ width: `${String(width)}%` }} />
            <Skeleton
              className="h-2.5"
              style={{ width: `${String(width + 20)}%` }}
            />
            <SkeletonThread order={order} className="mt-3 w-full" />
          </div>
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
  noticeKind,
  onNoticeKindChange,
  views,
}: Readonly<{
  /** Switches between notices and requests, when this person has both. */
  views?: ReactNode;
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  filter: WorkspaceInboxFilter;
  onFilterChange: (filter: WorkspaceInboxFilter) => void;
  noticeKind?: WorkspaceNoticeKind;
  onNoticeKindChange?: (kind: WorkspaceNoticeKind | undefined) => void;
}>) {
  const canRead = workspace.capabilities.includes('workspace:read');
  const scope = { apiClient, userId: user.id, workspaceId: workspace.id };
  const threads = useInfiniteQuery({
    ...inboxThreadsInfiniteQueryOptions({
      apiClient,
      userId: user.id,
      workspaceId: workspace.id,
      filter,
      noticeKind,
    }),
    enabled: canRead,
  });
  const summary = useQuery({
    ...inboxSummaryQueryOptions(apiClient, user.id, workspace.id),
    enabled: canRead,
  });
  const markAll = useMarkAllReadMutation(scope);

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

  // Mark-all reads what this list showed; later failures stay unread.
  const cut = threads.data?.pages[0]?.revision;
  const unreadCount = summary.data?.unreadCount;

  return (
    <div className="flex flex-col gap-8">
      <InboxHeader
        filter={filter}
        canMarkAll={cut !== undefined && (unreadCount ?? 0) > 0}
        marking={markAll.isPending}
        views={views}
        kindFilter={
          onNoticeKindChange === undefined ? undefined : (
            <NoticeKindFilter kind={noticeKind} onChange={onNoticeKindChange} />
          )
        }
        onFilter={onFilterChange}
        onMarkAll={() => {
          if (cut !== undefined) markAll.mutate(cut);
        }}
      />
      <InboxThreadResults
        scope={scope}
        threads={threads}
        filter={filter}
        markAllFailed={markAll.isError}
      />
    </div>
  );
}

/** Thread reads and the relative-time clock belong to the result list. */
function InboxThreadResults({
  scope,
  threads,
  filter,
  markAllFailed,
}: Readonly<{
  scope: InboxScope;
  threads: UseInfiniteQueryResult<InfiniteData<WorkspaceInboxListResponse>>;
  filter: WorkspaceInboxFilter;
  markAllFailed: boolean;
}>) {
  const markRead = useMarkThreadReadMutation(scope);
  const nowMs = useNow(60_000);
  return (
    <>
      {markRead.isError || markAllFailed ? (
        <Notice tone="destructive">
          That couldn’t be marked read. Nothing changed; try again.
        </Notice>
      ) : null}
      <QueryView
        query={threads}
        resource="The inbox"
        loading={<InboxSkeleton />}
        isEmpty={(data) => data.pages.every((page) => page.items.length === 0)}
        empty={<InboxEmpty filter={filter} />}
      >
        {(data) => (
          <ul aria-label="Notices" className="flex flex-col">
            {data.pages
              .flatMap((page) => page.items)
              .map((thread) => (
                <NoticeThreadRow
                  key={thread.id}
                  workspaceId={scope.workspaceId}
                  thread={thread}
                  nowMs={nowMs}
                  marking={
                    markRead.isPending &&
                    markRead.variables.threadId === thread.id
                  }
                  onRead={() => {
                    if (thread.unread)
                      markRead.mutate({
                        threadId: thread.id,
                        revision: thread.revision,
                      });
                  }}
                />
              ))}
          </ul>
        )}
      </QueryView>
      <LoadMore
        subject="notices"
        hasNextPage={threads.hasNextPage}
        loading={threads.isFetchingNextPage}
        failed={threads.isFetchNextPageError}
        onLoadMore={() => {
          void threads.fetchNextPage();
        }}
      />
    </>
  );
}
