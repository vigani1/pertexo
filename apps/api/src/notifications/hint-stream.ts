import {
  workspaceInboxStreamEventSchema,
  type WorkspaceInboxStreamEventName,
} from '@pertexo/contracts';

import { nextFrameOrAuthorizationLoss } from '../workflow-runs/events/sse-authorization-lifetime.js';
import type { InboxHintSubscription } from './inbox-hint-hub.js';

/** Keeps idle connections open through proxies with short idle timeouts. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface InboxStreamDestination {
  readonly destroyed: boolean;
  readonly writableNeedDrain: boolean;
  write(chunk: string): boolean;
  end(): void;
  once(event: 'close' | 'drain', listener: () => void): unknown;
  off(event: 'close' | 'drain', listener: () => void): unknown;
}

/** Resolves once buffered output flushes or the connection ends. */
function drained(
  destination: InboxStreamDestination,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const settle = (): void => {
      destination.off('drain', settle);
      destination.off('close', settle);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    destination.once('drain', settle);
    destination.once('close', settle);
    signal.addEventListener('abort', settle, { once: true });
    if (signal.aborted || destination.destroyed) settle();
  });
}

export type InboxStreamAuthorization = Readonly<{
  authorizationLost: AbortSignal;
  reauthorize(): Promise<void>;
}>;

function frame(
  event: WorkspaceInboxStreamEventName,
  revision: string | null,
): string {
  const data = workspaceInboxStreamEventSchema.parse({
    revision,
  });
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * ADR 055: writes content-free inbox hints until the client leaves, the
 * server drains, or the reader loses access. Hints never queue up: while the
 * client is slow the subscription keeps only the newest, because the client
 * refetches on any hint.
 */
export async function writeInboxHintStream(
  subscription: InboxHintSubscription,
  destination: InboxStreamDestination,
  authorization: InboxStreamAuthorization,
  signal: AbortSignal,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
): Promise<void> {
  const iterator = subscription[Symbol.asyncIterator]();
  const onAbort = (): void => {
    subscription.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const heartbeat = setInterval(() => {
    if (!destination.destroyed && !destination.writableNeedDrain)
      destination.write(': keepalive\n\n');
  }, heartbeatIntervalMs);
  heartbeat.unref();
  try {
    destination.write(frame('inbox.ready', null));
    while (!signal.aborted && !destination.destroyed) {
      const next = await nextFrameOrAuthorizationLoss(
        iterator,
        authorization.authorizationLost,
      );
      if (next.kind === 'authorization_lost') throw next.error;
      if (next.result.done === true) return;
      await authorization.reauthorize();
      // A slow client gets the newest hint once it catches up.
      if (destination.writableNeedDrain) {
        await drained(destination, signal);
        // The client may have left while its output drained.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (signal.aborted || destination.destroyed) return;
      }
      const hint = next.result.value;
      destination.write(
        frame('inbox.changed', hint.kind === 'changed' ? hint.revision : null),
      );
    }
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener('abort', onAbort);
    subscription.close();
    if (!destination.destroyed) destination.end();
  }
}
