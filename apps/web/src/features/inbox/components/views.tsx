import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { tasksQueryOptions } from '@/features/pending-tasks/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { inboxSummaryQueryOptions } from '../data/inbox.queries';

const viewClass =
  'flex shrink-0 items-center gap-2 rounded-sm px-3 py-1.5 text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground outline-none hover:text-foreground focus-ring aria-[current=page]:bg-action/10 aria-[current=page]:text-accent-foreground aria-[current=page]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--action)_22%,transparent)]';

function Count({ value }: Readonly<{ value: number | undefined }>) {
  if (value === undefined || value === 0) return null;
  return (
    <span className="font-mono text-[0.7rem] tabular-nums">
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
  current: 'notices' | 'requests';
}>) {
  const canReadNotices = workspace.capabilities.includes('workspace:read');
  const canReadRequests = workspace.capabilities.includes('run:read');
  const summary = useQuery({
    ...inboxSummaryQueryOptions(apiClient, userId, workspace.id),
    enabled: canReadNotices,
  });
  const waiting = useInfiniteQuery({
    ...tasksQueryOptions(
      { apiClient, userId, workspaceId: workspace.id },
      // The Requests view's own default filters, so both share one read.
      { kind: 'all', view: 'mine', status: 'pending' },
    ),
    enabled: canReadRequests,
  });
  if (!canReadNotices || !canReadRequests) return null;
  const unread = summary.data?.unreadCount;
  const pending = waiting.data?.pages[0]?.pendingCount;
  return (
    <nav
      aria-label="Inbox views"
      className="flex w-fit items-center gap-1 rounded-md border border-surface-ink/6 bg-recess-ink/25 p-[3px]"
    >
      <Link
        to="/w/$workspaceId/inbox"
        params={{ workspaceId: workspace.id }}
        aria-current={current === 'notices' ? 'page' : undefined}
        aria-label={
          unread === undefined || unread === 0
            ? 'Notices'
            : `Notices, ${String(unread)} unread`
        }
        className={viewClass}
      >
        Notices
        <Count value={unread} />
      </Link>
      <Link
        to="/w/$workspaceId/requests"
        params={{ workspaceId: workspace.id }}
        search={{ kind: 'all', view: 'mine', status: 'pending' }}
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
    </nav>
  );
}
