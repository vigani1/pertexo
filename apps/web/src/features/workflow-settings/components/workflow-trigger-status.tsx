import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { ApiClient } from '@/lib/api/client';
import { shownData } from '@/lib/api/error-copy';
import { formatCount } from '@/lib/format/count';
import { formatShortTime } from '@/lib/format/time';
import { workflowAutoPauseQueryOptions } from '../data/auto-pause.queries';

export function WorkflowTriggerStatus({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  children,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  children: ReactNode;
}>) {
  const query = useQuery(
    workflowAutoPauseQueryOptions(apiClient, userId, workspaceId, workflowId),
  );
  const settings = shownData(query);
  if (settings?.pauseState !== 'paused') return children;
  const cause =
    settings.pauseReason === 'manual'
      ? `Paused by ${settings.pausedBy.displayName ?? 'a workflow editor'} · ${formatShortTime(settings.pausedAt)}`
      : `Paused after ${formatCount(settings.pausedFailures, 'failure')}`;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusMark tone="waiting" display="mark" />
      <span className="truncate" title={cause}>
        {cause}
      </span>
    </span>
  );
}
