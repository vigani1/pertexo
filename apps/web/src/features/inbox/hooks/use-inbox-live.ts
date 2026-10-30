import type { ApiClient } from '@/lib/api/client';
import { decodeSseMessages, type SseMessage } from '@/lib/api/sse';
import {
  TransientStreamDisconnect,
  classifyStreamFailure,
  streamWasHealthy,
  waitToReconnect,
} from '@/lib/api/stream-reconnect';
import { workspaceInboxStreamEventSchema } from '@pertexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { openInboxEvents } from '../data/inbox.api';
import { inboxKeys } from '../data/inbox.queries';

export type InboxLiveStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';

const INBOX_EVENTS = new Set(['inbox.ready', 'inbox.changed']);
/** Hints arriving together cause one refetch. */
const COALESCE_MS = 250;

/** An inbox event with valid, content-free data; anything else is ignored. */
function isInboxHint(message: SseMessage): boolean {
  if (!INBOX_EVENTS.has(message.event)) return false;
  try {
    return workspaceInboxStreamEventSchema.safeParse(JSON.parse(message.data))
      .success;
  } catch {
    return false;
  }
}

/**
 * ADR 055: one hint stream per workspace per tab. Each hint, and each return
 * to the tab, refetches the inbox; hints carry no content, so a missed one
 * only delays a refresh. Stops when the person loses access.
 */
export function useInboxLive({
  apiClient,
  userId,
  workspaceId,
  enabled,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  enabled: boolean;
}>): InboxLiveStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<InboxLiveStatus>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let refreshTimer: number | undefined;
    let stream: Awaited<ReturnType<typeof openInboxEvents>> | undefined;
    const refresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void queryClient.invalidateQueries({
          queryKey: inboxKeys.scope(userId, workspaceId),
        });
      }, COALESCE_MS);
    };
    const report = (next: InboxLiveStatus) => {
      if (!signal.aborted) setStatus(next);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    const run = async () => {
      let failures = 0;
      while (!signal.aborted) {
        let openedAt: number | undefined;
        let delivered = false;
        try {
          report(failures === 0 ? 'connecting' : 'reconnecting');
          stream = await openInboxEvents(apiClient, workspaceId, signal);
          openedAt = Date.now();
          report('live');
          for await (const message of decodeSseMessages(stream.body)) {
            // The signal can change while the stream awaits its next chunk.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (signal.aborted) return;
            // A ready event also closes the gap between loading and listening.
            if (isInboxHint(message)) {
              delivered = true;
              refresh();
            }
          }
          throw new TransientStreamDisconnect('The inbox stream closed.');
        } catch (error: unknown) {
          // Cancellation may arrive while opening or reading the stream awaits I/O.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (signal.aborted) return;
          if (streamWasHealthy({ delivered, openedAt })) failures = 0;
          failures += 1;
          const recovery = classifyStreamFailure(error, failures);
          if (recovery.kind === 'stop') {
            report('paused');
            return;
          }
          report('reconnecting');
          // Whatever arrived while disconnected shows up now.
          refresh();
          await waitToReconnect(recovery.delayMs, signal);
        } finally {
          stream?.close();
          stream = undefined;
        }
      }
    };
    void run();

    return () => {
      controller.abort();
      stream?.close();
      document.removeEventListener('visibilitychange', onVisible);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [apiClient, enabled, queryClient, userId, workspaceId]);

  return enabled ? status : 'paused';
}
