import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import { FinishedThread } from '@/components/patterns/states/thread-illustrations';
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useNow } from '@/lib/hooks/use-now';
import { tasksQueryOptions } from '../data/tasks.queries';
import type { TaskScope } from '../data/tasks.api';
import { TaskRow } from './task-row';
function NoTasks({
  compact,
  waiting,
}: Readonly<{ compact: boolean; waiting: boolean }>) {
  if (compact)
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {waiting
          ? 'No requests waiting for you.'
          : 'No requests match this view.'}
      </p>
    );
  return (
    <Empty>
      <EmptyMedia className="w-full max-w-56">
        <FinishedThread />
      </EmptyMedia>
      <EmptyTitle>
        {waiting ? 'Nothing is waiting' : 'No requests here'}
      </EmptyTitle>
      <EmptyDescription>
        {waiting
          ? 'When a workflow needs an approval or a person’s input, it pauses and asks here.'
          : 'Try another status or show everyone’s requests.'}
      </EmptyDescription>
    </Empty>
  );
}

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
  // Expiry reads "expires in 12 minutes"; a minute's tick keeps it honest.
  const nowMs = useNow({ intervalMs: 60_000 });
  return (
    <QueryView
      query={query}
      resource="Requests"
      loading={<SkeletonRows label="Loading requests" rows={compact ? 2 : 4} />}
    >
      {(data) => {
        const items = data.pages.flatMap((page) => page.items);
        return (
          <div>
            {items.length === 0 ? (
              <NoTasks
                compact={compact}
                waiting={filters.status === 'pending'}
              />
            ) : (
              <ul className="-mx-3">
                {(compact ? items.slice(0, 5) : items).map((task) => (
                  <TaskRow
                    key={task.id}
                    scope={scope}
                    task={task}
                    nowMs={nowMs}
                  />
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
      }}
    </QueryView>
  );
}
export function PendingTasks({
  scope,
  runId,
  kind,
}: Readonly<{
  scope: TaskScope;
  runId?: string;
  kind?: 'approval' | 'input_request';
}>) {
  return (
    <section
      aria-label="Requests"
      className="rounded-xl border border-border p-4"
    >
      <h2 className="font-medium">Requests</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {runId === undefined
          ? kind === 'input_request'
            ? 'Input waiting for your response.'
            : 'Approvals and input waiting for your response.'
          : 'Approvals and requested input for this run.'}
      </p>
      <TaskList
        scope={scope}
        filters={
          runId === undefined
            ? {
                view: 'mine',
                status: 'pending',
                ...(kind === undefined ? {} : { kind }),
              }
            : { view: 'all', status: 'all', runId }
        }
        compact
      />
    </section>
  );
}
