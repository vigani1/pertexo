import { isApiError } from '@/lib/api/error';
import type { LiveConnectionStatus as ConnectionStatus } from './live-updates';

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

type StreamRecovery =
  | Readonly<{
      kind: 'stop';
      status: ConnectionStatus;
      message: string;
    }>
  | Readonly<{
      kind: 'retry';
      status: ConnectionStatus;
      message: string;
      delayMs: number;
    }>;

export function classifyStreamFailure(
  error: unknown,
  failures: number,
): StreamRecovery {
  if (isApiError(error)) {
    if (error.status === 401)
      return {
        kind: 'stop',
        status: 'authentication-required',
        message:
          'Live updates paused because your session ended. Sign in again to resume them.',
      };
    if (error.status === 403)
      return {
        kind: 'stop',
        status: 'access-denied',
        message:
          'Live updates paused because your role can’t follow this run any more.',
      };
    if (error.status === 404)
      return {
        kind: 'stop',
        status: 'unavailable',
        message: 'Live updates aren’t available for this run.',
      };
    if (error.status === 429)
      return {
        kind: 'retry',
        status: 'rate-limited',
        message:
          'Too many live connections right now. Updates resume on their own shortly.',
        delayMs: Math.min(
          300_000,
          error.retryAfterMs ?? transientDelay(failures),
        ),
      };
    if (error.kind === 'canceled')
      return {
        kind: 'stop',
        status: 'stopped',
        message: 'Live updates were stopped.',
      };
    const terminalStreamFailure =
      error.kind !== 'network' &&
      error.kind !== 'timeout' &&
      (error.status === undefined || error.status < 500);
    if (terminalStreamFailure)
      return {
        kind: 'stop',
        status: 'failed',
        message:
          'Live updates paused because Pertexo sent an update this page couldn’t read.',
      };
  } else {
    const unsupportedStreamDisconnect =
      !(error instanceof TransientStreamDisconnect) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === 'NetworkError');
    if (unsupportedStreamDisconnect) {
      return {
        kind: 'stop',
        status: 'failed',
        message: 'Live updates paused because an update couldn’t be read.',
      };
    }
  }
  return {
    kind: 'retry',
    status: failures >= 3 ? 'degraded' : 'reconnecting',
    message:
      failures >= 3
        ? 'Live updates keep dropping. Pertexo still checks the run and keeps reconnecting.'
        : 'Live updates disconnected. Reconnecting…',
    delayMs: transientDelay(failures),
  };
}

export class TransientStreamDisconnect extends Error {}

function transientDelay(failures: number): number {
  return (
    Math.min(10_000, 500 * 2 ** Math.min(failures, 4)) +
    Math.floor(Math.random() * 250)
  );
}

export function delay(durationMs: number, signal: AbortSignal): Promise<void> {
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
