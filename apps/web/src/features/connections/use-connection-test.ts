import { useRef, useState } from 'react';
import type {
  ConnectionResponse,
  ConnectionTestRequest,
  ConnectionTestResponse,
} from '@pertexo/contracts/schemas/connections';
import { useNotifications } from '@/components/ui/use-notifications';
import { isUncertainOutcome } from '@/lib/api/api-error-copy';
import { connectionCommandError } from './connection-errors';
import {
  useTestConnectionMutation,
  type ConnectionMutationScope,
  type TestConnectionCommand,
} from './connections.mutations';
import type { TestPhase } from './model/connection-health';

export type ConnectionTest = Readonly<{
  phase: TestPhase;
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
    return isUncertainOutcome(mutation.error) ? 'unsure' : 'failed';
  return 'idle';
}

/**
 * Tests one connection. An unconfirmed attempt repeats with the same key, so
 * the provider is not called twice for one test; anything else starts fresh.
 */
export function useConnectionTest(
  scope: ConnectionMutationScope,
): ConnectionTest {
  const notifications = useNotifications();
  const mutation = useTestConnectionMutation(scope);
  const attempt = useRef<TestConnectionCommand | undefined>(undefined);
  const [targetName, setTargetName] = useState('This connection');

  async function send(command: TestConnectionCommand, name: string) {
    try {
      const result = await mutation.mutateAsync(command);
      attempt.current = undefined;
      if (result.outcome.ok)
        notifications.success({ title: `${name} passed its test` });
    } catch {
      // The mutation's error renders as the test outcome.
    }
  }

  function run(
    connection: Pick<ConnectionResponse, 'id' | 'name'>,
    request: ConnectionTestRequest,
  ) {
    if (mutation.isPending) return;
    const previous = attempt.current;
    const repeat =
      previous !== undefined &&
      mutation.isError &&
      isUncertainOutcome(mutation.error) &&
      previous.connectionId === connection.id &&
      JSON.stringify(previous.request) === JSON.stringify(request);
    const command: TestConnectionCommand = repeat
      ? previous
      : {
          connectionId: connection.id,
          request,
          idempotencyKey: crypto.randomUUID(),
        };
    attempt.current = command;
    setTargetName(connection.name);
    void send(command, connection.name);
  }

  return {
    phase: phaseOf(mutation),
    result: mutation.data,
    error: mutation.isError
      ? connectionCommandError(mutation.error, 'test', targetName)
      : undefined,
    run,
    reset: () => {
      attempt.current = undefined;
      mutation.reset();
    },
  };
}
