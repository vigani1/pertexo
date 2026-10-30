import {
  classifyStreamFailure,
  type StreamRecovery,
} from '@/lib/api/stream-reconnect';
import type { LiveConnectionStatus as ConnectionStatus } from './live-updates';

type RunStreamRecovery = Readonly<{
  status: ConnectionStatus;
  message: string;
}> &
  (Readonly<{ kind: 'stop' }> | Readonly<{ kind: 'retry'; delayMs: number }>);

const STOPPED: Readonly<
  Record<
    Extract<StreamRecovery, { kind: 'stop' }>['reason'],
    Readonly<{ status: ConnectionStatus; message: string }>
  >
> = {
  'session-ended': {
    status: 'authentication-required',
    message:
      'Live updates paused because your session ended. Sign in again to resume them.',
  },
  'access-denied': {
    status: 'access-denied',
    message:
      'Live updates paused because your role can’t follow this run any more.',
  },
  unavailable: {
    status: 'unavailable',
    message: 'Live updates aren’t available for this run.',
  },
  canceled: { status: 'stopped', message: 'Live updates were stopped.' },
  unreadable: {
    status: 'failed',
    message:
      'Live updates paused because Pertexo sent an update this page couldn’t read.',
  },
};

/** The shared reconnect policy, in the words of one run's live view. */
export function runStreamRecovery(
  error: unknown,
  failures: number,
): RunStreamRecovery {
  const recovery = classifyStreamFailure(error, failures);
  if (recovery.kind === 'stop')
    return { kind: 'stop', ...STOPPED[recovery.reason] };
  if (recovery.reason === 'rate-limited')
    return {
      kind: 'retry',
      status: 'rate-limited',
      message:
        'Too many live connections right now. Updates resume on their own shortly.',
      delayMs: recovery.delayMs,
    };
  return {
    kind: 'retry',
    status: failures >= 3 ? 'degraded' : 'reconnecting',
    message:
      failures >= 3
        ? 'Live updates keep dropping. Pertexo still checks the run and keeps reconnecting.'
        : 'Live updates disconnected. Reconnecting…',
    delayMs: recovery.delayMs,
  };
}
