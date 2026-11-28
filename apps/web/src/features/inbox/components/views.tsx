import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { tasksQueryOptions } from '@/features/pending-tasks/pending-tasks-queries.public';
import type { ApiClient } from '@/lib/api/client';
import { inboxSummaryQueryOptions } from '../data/inbox.queries';

const viewClass =
  'flex shrink-0 items-center gap-2 pointer-coarse:min-h-10 rounded-sm px-3 py-1.5 text-label font-medium whitespace-nowrap text-subtle-foreground outline-none hover:text-foreground focus-ring aria-[current=page]:bg-action/10 aria-[current=page]:text-accent-foreground aria-[current=page]:inset-ring aria-[current=page]:inset-ring-action-line';

function Count({ value }: Readonly<{ value: number | undefined }>) {
  if (value === undefined || value === 0) return null;
  return (
    <span className="font-mono text-caption tabular-nums">
      {value > 99 ? '99+' : value}
    </span>
  );
}

/**
 * Everything that waits for you, in one place: notices about the workspace
 * and requests only a person can answer. Each view keeps its own address.
 */
export function InboxViews({
  apiClient,
  userId,
  workspace,
  current,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  current: 'approvals' | 'notices' | 'requests';
}>) {
  const canReadNotices = workspace.capabilities.includes('workspace:read');
  const canReadRequests = workspace.capabilities.includes('run:read');
  const summary = useQuery({
    ...inboxSummaryQueryOptions(apiClient, userId, workspace.id),
    enabled: canReadNotices,
  });
  const approvals = useInfiniteQuery({
    ...tasksQueryOptions(
      { apiClient, userId, workspaceId: workspace.id },
      { kind: 'approval', view: 'mine', status: 'pending' },
    ),
    enabled: canReadRequests,
  });
  const requests = useInfiniteQuery({
    ...tasksQueryOptions(
      { apiClient, userId, workspaceId: workspace.id },
      { kind: 'input_request', view: 'mine', status: 'pending' },
    ),
    enabled: canReadRequests,
  });
  if (!canReadNotices || !canReadRequests) return null;
  const unread = summary.data?.unreadCount;
  const pending = requests.data?.pages[0]?.pendingCount;
  const pendingApprovals = approvals.data?.pages[0]?.pendingCount;
  return (
    <nav
      aria-label="Inbox views"
      className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-md border border-surface-ink/6 bg-recess-ink/25 p-[3px]"
    >
      <Link
        to="/w/$workspaceId/requests"
        params={{ workspaceId: workspace.id }}
        search={{ kind: 'approval', view: 'mine', status: 'pending' }}
        aria-current={current === 'approvals' ? 'page' : undefined}
        className={viewClass}
      >
        Approvals
        <Count value={pendingApprovals} />
      </Link>
      <Link
        to="/w/$workspaceId/requests"
        params={{ workspaceId: workspace.id }}
        search={{ kind: 'input_request', view: 'mine', status: 'pending' }}
        aria-current={current === 'requests' ? 'page' : undefined}
        aria-label={
          pending === undefined || pending === 0
            ? 'Requests'
            : `Requests, ${String(pending)} waiting for you`
        }
        className={viewClass}
      >
        Requests
        <Count value={pending} />
      </Link>
      <Link
        to="/w/$workspaceId/inbox"
        params={{ workspaceId: workspace.id }}
        search={{ filter: 'all' }}
        aria-current={current === 'notices' ? 'page' : undefined}
        aria-label={unread ? `Notices, ${String(unread)} unread` : 'Notices'}
        className={viewClass}
      >
        Notices
        <Count value={unread} />
      </Link>
    </nav>
  );
}
