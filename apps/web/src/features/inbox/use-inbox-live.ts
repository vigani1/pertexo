import { workspaceInboxStreamEventSchema } from '@pertexo/contracts/schemas/workspace-inbox';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { decodeSseMessages, type SseMessage } from '@/lib/api/sse';
import { openInboxEvents } from './inbox.api';
import { inboxKeys } from './inbox.queries';

export type InboxLiveStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';

const INBOX_EVENTS = new Set(['inbox.ready', 'inbox.changed']);
/** Hints arriving together cause one refetch. */
const COALESCE_MS = 250;
const MAX_RETRY_MS = 30_000;
/** A stream open this long was healthy; its drop starts a fresh backoff. */
const HEALTHY_STREAM_MS = 30_000;

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

/** Access or the stream contract changed; retrying would not help. */
function stopsLiveUpdates(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 404)
    return true;
  return error.kind === 'protocol';
}

function retryDelay(error: unknown, failures: number): number {
  if (
    isApiError(error) &&
    error.status === 429 &&
    error.retryAfterMs !== undefined
  )
    return Math.min(300_000, error.retryAfterMs);
  const base = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(failures, 5));
  // Jitter keeps many tabs from reconnecting in step after an outage.
  return base / 2 + Math.random() * (base / 2);
}

function wait(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, durationMs);
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * ADR 055: one hint stream per workspace per tab. Each hint, and each return
 * to the tab, refetches the inbox; hints carry no content, so a missed one
 * only delays a refresh. Stops when the person loses access.
 */
export function useInboxLive(
  apiClient: ApiClient,
  userId: string,
  workspaceId: string,
  enabled: boolean,
): InboxLiveStatus {
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
            if (isInboxHint(message)) refresh();
          }
          throw new Error('The inbox stream closed.');
        } catch (error: unknown) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (signal.aborted) return;
          if (stopsLiveUpdates(error)) {
            report('paused');
            return;
          }
          if (
            openedAt !== undefined &&
            Date.now() - openedAt >= HEALTHY_STREAM_MS
          )
            failures = 0;
          failures += 1;
          report('reconnecting');
          // Whatever arrived while disconnected shows up now.
          refresh();
          await wait(retryDelay(error, failures), signal);
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
