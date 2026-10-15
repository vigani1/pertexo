import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import { LoadMore } from '@/components/patterns/load-more';
import { ReadFailure } from '@/components/patterns/states/read-failure';
import { Skeleton } from '@/components/ui/skeleton';
import { tasksQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import { TaskRow } from './task-row';
export function TaskList({
  scope,
  filters,
  compact = false,
}: Readonly<{
  scope: TaskScope;
  filters: Omit<PendingTaskListQuery, 'after'>;
  compact?: boolean;
}>) {
  const query = useInfiniteQuery(tasksQueryOptions(scope, filters));
  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  if (query.isError)
    return (
      <ReadFailure
        resource="Requests"
        showing={false}
        retrying={query.isFetching}
        updatedAt={query.dataUpdatedAt}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <div>
      {filters.view === 'mine' &&
      filters.status === 'pending' &&
      filters.runId === undefined ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {query.data.pages[0]?.pendingCount ?? 0} ready for your response
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {filters.status === 'pending'
            ? 'No requests waiting for you.'
            : 'No requests match this view.'}
        </p>
      ) : (
        <ul>
          {(compact ? items.slice(0, 5) : items).map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
      {compact ? (
        <Link
          to="/w/$workspaceId/requests"
          search={{ view: 'mine', status: 'pending' }}
          params={{ workspaceId: scope.workspaceId }}
          className="mt-3 inline-block text-sm underline underline-offset-4"
        >
          View all requests
        </Link>
      ) : (
        <LoadMore
          hasNextPage={query.hasNextPage}
          loading={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          subject="requests"
          onLoadMore={() => void query.fetchNextPage()}
        />
      )}
    </div>
  );
}
export function PendingTasks({
  scope,
  runId,
}: Readonly<{ scope: TaskScope; runId?: string }>) {
  return (
    <section
      aria-label="Requests"
      className="rounded-xl border border-border p-4"
    >
      <h2 className="font-medium">Requests</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {runId === undefined
          ? 'Approvals and input waiting for your response.'
          : 'Approvals and requested input for this run.'}
      </p>
      <TaskList
        scope={scope}
        filters={
          runId === undefined
            ? { view: 'mine', status: 'pending' }
            : { view: 'all', status: 'all', runId }
        }
        compact
      />
    </section>
  );
}
