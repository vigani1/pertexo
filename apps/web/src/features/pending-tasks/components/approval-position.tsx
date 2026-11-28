import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { PendingTaskListQuery } from '@pertexo/contracts';
import type { TaskScope } from '../data/tasks.api';
import { tasksQueryOptions } from '../data/tasks.queries';
import { bySoonestDeadline } from '../model/task-presentation';

export function ApprovalPosition({
  scope,
  taskId,
  view,
}: Readonly<{
  scope: TaskScope;
  taskId: string;
  view: PendingTaskListQuery['view'];
}>) {
  const filters = { kind: 'approval', view, status: 'pending' } as const;
  const queue = useInfiniteQuery(tasksQueryOptions(scope, filters));
  // Cursor pages arrive in creation order. Only the complete queue can give
  // a deadline-sorted position and next approval.
  if (queue.isError || queue.data === undefined || queue.hasNextPage)
    return null;
  const items = queue.data.pages
    .flatMap((page) => page.items)
    .sort(bySoonestDeadline);
  const index = items.findIndex((item) => item.id === taskId);
  if (index === -1) return null;
  const next = items[index + 1];
  return (
    <nav
      aria-label="Pending approval position"
      className="flex flex-wrap items-center justify-between gap-x-2 pb-1 text-sm text-muted-foreground md:hidden"
    >
      <span>
        {index + 1} of {items.length}
      </span>
      {next === undefined ? null : (
        <Link
          to="/w/$workspaceId/requests/$taskId"
          params={{ workspaceId: scope.workspaceId, taskId: next.id }}
          search={filters}
          className="inline-flex min-h-10 min-w-0 items-center wrap-anywhere text-accent-foreground underline-offset-4 hover:underline"
        >
          Next: {next.title}
        </Link>
      )}
    </nav>
  );
}
