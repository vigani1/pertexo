import { useCommandAttempt } from '@/lib/api/commands/use-command-attempt';
import { RETRY_WINDOW_ENDED } from '@/lib/api/commands/command-retry';
import { useState } from 'react';
import type {
  ConnectionResponse,
  ConnectionTestRequest,
  ConnectionTestResponse,
} from '@pertexo/contracts';
import { useNotifications } from '@/components/ui/use-notifications';
import {
  isUnconfirmedCommand,
  newCommandKey,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import { connectionCommandError } from '../../model/connection-errors';
import {
  useTestConnectionMutation,
  type ConnectionMutationScope,
  type TestConnectionCommand,
} from '../../data/connections.mutations';
import type { TestPhase } from '../../model/connection-health';

export type ConnectionTest = Readonly<{
  phase: TestPhase;
  expired: boolean;
  startNewAttempt: () => void;
  result: ConnectionTestResponse | undefined;
  /** A failed command (not a provider's answer), already in words. */
  error: string | undefined;
  run: (
    connection: Pick<ConnectionResponse, 'id' | 'name'>,
    request: ConnectionTestRequest,
  ) => void;
  reset: () => void;
}>;

function phaseOf(
  mutation: ReturnType<typeof useTestConnectionMutation>,
): TestPhase {
  if (mutation.isPending) return 'running';
  if (mutation.isSuccess) return mutation.data.outcome.ok ? 'ok' : 'failed';
  if (mutation.isError)
    return isUnconfirmedCommand(mutation.error) ? 'unsure' : 'failed';
  return 'idle';
}

/**
 * Tests one connection. An unconfirmed attempt repeats with the same key, so
 * the provider is not called twice for one test; anything else starts fresh.
 * A pass is also confirmed with a toast, unless `toastOnPass` is false: the
 * add flow's last step already shows the result in place, above the button
 * a toast would cover.
 */
export function useConnectionTest(
  scope: ConnectionMutationScope,
  { toastOnPass = true }: Readonly<{ toastOnPass?: boolean }> = {},
): ConnectionTest {
  const notifications = useNotifications();
  const mutation = useTestConnectionMutation(scope);
  const attempt = useCommandAttempt<TestConnectionCommand & CommandKey>();
  const [targetName, setTargetName] = useState('This connection');

  async function send(command: TestConnectionCommand, name: string) {
    try {
      const result = await mutation.mutateAsync(command);
      attempt.clear();
      if (result.outcome.ok && toastOnPass)
        notifications.success({ title: `${name} passed its test` });
    } catch (cause) {
      if (!isUnconfirmedCommand(cause)) attempt.clear();
      // The mutation's error renders as the test outcome.
    }
  }

  async function run(
    connection: Pick<ConnectionResponse, 'id' | 'name'>,
    request: ConnectionTestRequest,
  ) {
    if (mutation.isPending) return;
    const command = await attempt.getOrCreate(() => ({
      connectionId: connection.id,
      request,
      ...newCommandKey(),
    }));
    if (command === undefined) return;
    setTargetName(connection.name);
    void send(command, connection.name);
  }

  const error = mutation.isError
    ? connectionCommandError(mutation.error, 'test', targetName)
    : undefined;
  return {
    phase: phaseOf(mutation),
    result: mutation.data,
    expired: attempt.expired,
    startNewAttempt: () => {
      attempt.clear();
      mutation.reset();
    },
    error: attempt.expired ? RETRY_WINDOW_ENDED : error,
    run: (connection, request) => {
      void run(connection, request);
    },
    reset: () => {
      attempt.clear();
      mutation.reset();
    },
  };
}
