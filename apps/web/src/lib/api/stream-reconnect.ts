import { isApiError } from './error';

/** How long a quiet stream stays open before a drop counts as a fresh one. */
const HEALTHY_STREAM_MS = 30_000;

/**
 * A stream that delivered events, or stayed open a while, was healthy: its
 * drop starts a fresh count rather than adding to the drops before it.
 */
export function streamWasHealthy({
  delivered,
  openedAt,
}: Readonly<{ delivered: boolean; openedAt: number | undefined }>): boolean {
  return (
    delivered ||
    (openedAt !== undefined && Date.now() - openedAt >= HEALTHY_STREAM_MS)
  );
}

/** Whether to keep reconnecting, and why; each feature words it its own way. */
export type StreamRecovery =
  | Readonly<{
      kind: 'stop';
      reason:
        | 'session-ended'
        | 'access-denied'
        | 'unavailable'
        | 'canceled'
        | 'unreadable';
    }>
  | Readonly<{
      kind: 'retry';
      reason: 'rate-limited' | 'disconnected';
      delayMs: number;
    }>;

/** The stream ended early and normally; reconnecting may help. */
export class TransientStreamDisconnect extends Error {}

export function classifyStreamFailure(
  error: unknown,
  failures: number,
): StreamRecovery {
  if (isApiError(error)) {
    if (error.status === 401) return { kind: 'stop', reason: 'session-ended' };
    if (error.status === 403) return { kind: 'stop', reason: 'access-denied' };
    if (error.status === 404) return { kind: 'stop', reason: 'unavailable' };
    if (error.status === 429)
      return {
        kind: 'retry',
        reason: 'rate-limited',
        delayMs: Math.min(
          300_000,
          error.retryAfterMs ?? reconnectDelay(failures),
        ),
      };
    if (error.kind === 'canceled') return { kind: 'stop', reason: 'canceled' };
    // A gateway answering for a restarting API sends a 5xx without problem
    // details; that passes, so only an unreadable non-5xx answer is final.
    const terminalStreamFailure =
      error.kind !== 'network' &&
      error.kind !== 'timeout' &&
      (error.status === undefined || error.status < 500);
    if (terminalStreamFailure) return { kind: 'stop', reason: 'unreadable' };
  } else {
    const unsupportedStreamDisconnect =
      !(error instanceof TransientStreamDisconnect) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === 'NetworkError');
    if (unsupportedStreamDisconnect)
      return { kind: 'stop', reason: 'unreadable' };
  }
  return {
    kind: 'retry',
    reason: 'disconnected',
    delayMs: reconnectDelay(failures),
  };
}

function reconnectDelay(failures: number): number {
  // Jitter keeps many tabs from reconnecting in step after an outage.
  return (
    Math.min(10_000, 500 * 2 ** Math.min(failures, 4)) +
    Math.floor(Math.random() * 250)
  );
}

/** Waits before reconnecting; ends early once the stream's owner is gone. */
export function waitToReconnect(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
