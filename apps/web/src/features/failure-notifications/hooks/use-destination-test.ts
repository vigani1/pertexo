import {
  canResend,
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/contract';
import { useRef } from 'react';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import { isApiError } from '@/lib/api/error';
import {
  describeTestOutcome,
  type TestPhase,
} from '@/features/connections/provider.public';
import {
  useTestFailureNotificationDestinationMutation,
  type DestinationMutationScope,
} from '../data/failure-notifications.mutations';

type Command = Readonly<{
  destinationId: string;
  expectedVersion: number;
}> &
  CommandKey;
const UNKNOWN_CODES = new Set([
  'connection.test.timed_out',
  'connection.test.network_failed',
  'connection.test.canceled',
  'connection.provider_invalid_response',
]);

/** A 500 is Pertexo's own failure and no gateway's, so nothing was left unconfirmed. */
function failedOnOurSide(error: unknown): boolean {
  return isApiError(error) && error.status === 500;
}

function phaseOf(
  mutation: ReturnType<typeof useTestFailureNotificationDestinationMutation>,
): TestPhase {
  if (mutation.isPending) return 'running';
  if (mutation.isError)
    return isUnconfirmedCommand(mutation.error) &&
      !failedOnOurSide(mutation.error)
      ? 'unsure'
      : 'failed';
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
    // Past its window a held test is forgotten; a test may simply run again.
    const command =
      phase === 'unsure' &&
      attempt.current !== undefined &&
      canResend(attempt.current)
        ? attempt.current
        : {
            destinationId: destination.id,
            expectedVersion: destination.currentVersion,
            ...newCommandKey(),
          };
    attempt.current = command;
    void send(command);
  }
  return { phase, run, failure: failureOf(mutation, destination) };
}

/** What went wrong in words, so a refusal or our own failure isn't blamed on the destination. */
function failureOf(
  mutation: ReturnType<typeof useTestFailureNotificationDestinationMutation>,
  destination: FailureNotificationDestinationResponse,
): string | undefined {
  if (failedOnOurSide(mutation.error))
    return 'Pertexo couldn’t send the test. The problem is on Pertexo’s side, not with this destination. Try again.';
  if (mutation.data === undefined || mutation.data.outcome.ok) return undefined;
  const { title, detail } = describeTestOutcome(
    destination.kind,
    mutation.data.outcome,
  );
  return `${title} ${detail}`;
}
