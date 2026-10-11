import { useRef } from 'react';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import type { TestPhase } from '@/features/connections/provider.public';
import { isUncertainOutcome } from '@/lib/api/error-copy';
import {
  useTestFailureNotificationDestinationMutation,
  type DestinationMutationScope,
} from '../data/failure-notifications.mutations';

type Command = Readonly<{
  destinationId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;
const UNKNOWN_CODES = new Set([
  'connection.test.timed_out',
  'connection.test.network_failed',
  'connection.test.canceled',
  'connection.provider_invalid_response',
]);

function phaseOf(
  mutation: ReturnType<typeof useTestFailureNotificationDestinationMutation>,
): TestPhase {
  if (mutation.isPending) return 'running';
  if (mutation.isError)
    return isUncertainOutcome(mutation.error) ? 'unsure' : 'failed';
  if (mutation.isSuccess) {
    if (mutation.data.outcome.ok) return 'ok';
    return UNKNOWN_CODES.has(mutation.data.outcome.errorCode)
      ? 'unsure'
      : 'failed';
  }
  return 'idle';
}

/** Owns the attempt key so an unconfirmed delivery is checked, never blindly resent. */
export function useDestinationTest(
  scope: DestinationMutationScope,
  destination: FailureNotificationDestinationResponse,
) {
  const mutation = useTestFailureNotificationDestinationMutation(scope);
  const attempt = useRef<Command | undefined>(undefined);
  const phase = phaseOf(mutation);
  async function send(command: Command) {
    try {
      await mutation.mutateAsync(command);
    } catch {
      // The mutation result owns the visible thread and outcome.
    }
  }
  function run() {
    if (mutation.isPending) return;
    const command =
      phase === 'unsure' && attempt.current !== undefined
        ? attempt.current
        : {
            destinationId: destination.id,
            expectedVersion: destination.currentVersion,
            idempotencyKey: crypto.randomUUID(),
          };
    attempt.current = command;
    void send(command);
  }
  return { phase, run };
}
