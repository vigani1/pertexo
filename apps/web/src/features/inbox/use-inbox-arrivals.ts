import type {
  WorkspaceInboxSummaryResponse,
  WorkspaceInboxThread,
} from '@pertexo/contracts/schemas/workspace-inbox';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef } from 'react';
import type { InboxScope } from './inbox.mutations';
import { inboxThreadsInfiniteQueryOptions } from './inbox.queries';
import { arrivedThreads, isLaterRevision } from './model/inbox-arrival';

type Seen = Readonly<{ scope: string; revision: string }>;

/**
 * Calls `onArrive` with the unread notices that changed after the summary
 * revision this tab last delivered. The first summary for a workspace is the
 * baseline, so loading a page or switching workspaces announces nothing. A
 * newer revision that lands mid-fetch refetches from the same baseline, so
 * nothing in between is skipped.
 */
export function useInboxArrivals(
  scope: InboxScope,
  summary: WorkspaceInboxSummaryResponse | undefined,
  onArrive: (threads: readonly WorkspaceInboxThread[]) => void,
): void {
  const queryClient = useQueryClient();
  const arrive = useEffectEvent(onArrive);
  const seen = useRef<Seen | undefined>(undefined);
  const { apiClient, userId, workspaceId } = scope;
  const scopeKey = `${userId}/${workspaceId}`;
  const revision = summary?.revision;
  const unreadCount = summary?.unreadCount;

  useEffect(() => {
    if (revision === undefined || unreadCount === undefined) return;
    const last = seen.current;
    if (last?.scope !== scopeKey || !isLaterRevision(revision, last.revision)) {
      seen.current = { scope: scopeKey, revision };
      return;
    }
    if (unreadCount === 0) {
      seen.current = { scope: scopeKey, revision };
      return;
    }
    let current = true;
    queryClient
      .infiniteQuery({
        ...inboxThreadsInfiniteQueryOptions(
          apiClient,
          userId,
          workspaceId,
          'unread',
        ),
        // The cached list can predate the summary that announced the change.
        staleTime: 0,
      })
      .then(
        (threads) => {
          if (!current) return;
          seen.current = { scope: scopeKey, revision };
          const arrived = arrivedThreads(
            threads.pages[0]?.items ?? [],
            last.revision,
          );
          if (arrived.length > 0) arrive(arrived);
        },
        () => {
          // The next change retries from the same baseline.
        },
      );
    return () => {
      current = false;
    };
  }, [
    apiClient,
    queryClient,
    revision,
    scopeKey,
    unreadCount,
    userId,
    workspaceId,
  ]);
}
