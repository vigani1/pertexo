import { useQueryClient } from '@tanstack/react-query';
import { useReadRetry } from '@/lib/hooks/use-read-retry';
import { failureNotificationDestinationKeys } from '../data/failure-notifications.queries';
import { isDestinationConflict } from '../model/failure-notification-errors';
import { destinationCommandError } from '../model/failure-notification-errors';
import { useCommandAttempt } from '@/lib/api/commands/use-command-attempt';
import {
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
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
  const attempt = useCommandAttempt<Command>();
  const cache = useQueryClient();
  const waitSeconds = useReadRetry(mutation.error);
  const phase = phaseOf(mutation);
  async function send(command: Command) {
    try {
      const result = await mutation.mutateAsync(command);
      if (result.outcome.ok || !UNKNOWN_CODES.has(result.outcome.errorCode))
        attempt.clear();
    } catch (cause) {
      if (!isUnconfirmedCommand(cause) || failedOnOurSide(cause))
        attempt.clear();
      // The mutation result owns the visible thread and outcome.
    }
  }
  async function run() {
    if (mutation.isPending) return;
    const command = await attempt.getOrCreate(() => ({
      destinationId: destination.id,
      expectedVersion: destination.currentVersion,
      ...newCommandKey(),
    }));
    if (command === undefined) return;
    void send(command);
  }
  return {
    phase,
    waitSeconds,
    permissionLost: isApiError(mutation.error) && mutation.error.status === 403,
    conflict: isDestinationConflict(mutation.error),
    reload: () => {
      void cache.refetchQueries({
        queryKey: failureNotificationDestinationKeys.scope(
          scope.userId,
          scope.workspaceId,
        ),
      });
    },
    expired: attempt.expired,
    run: () => {
      void run();
    },
    startNewAttempt: () => {
      attempt.clear();
      void run();
    },
    failure: failureOf(mutation, destination),
  };
}

/** What went wrong in words, so a refusal or our own failure isn't blamed on the destination. */
function failureOf(
  mutation: ReturnType<typeof useTestFailureNotificationDestinationMutation>,
  destination: FailureNotificationDestinationResponse,
): string | undefined {
  if (failedOnOurSide(mutation.error))
    return 'Pertexo couldn’t send the test. The problem is on Pertexo’s side, not with this destination. Try again.';
  if (mutation.isError) return destinationCommandError(mutation.error, 'test');
  if (mutation.data === undefined || mutation.data.outcome.ok) return undefined;
  const { title, detail } = describeTestOutcome(
    destination.kind === 'system_mail' ? 'email' : destination.kind,
    mutation.data.outcome,
  );
  return `${title} ${detail}`;
}
