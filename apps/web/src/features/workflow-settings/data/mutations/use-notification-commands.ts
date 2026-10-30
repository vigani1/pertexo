import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { isUnconfirmedCommand } from '@/lib/api/commands/contract';
import {
  clearFailureNotificationPolicy,
  setFailureNotificationPolicy,
} from '../workflow-settings.api';
import { workflowSettingsKeys } from '../workflow-settings.queries';
import {
  settingsCommandError,
  useCommandAttemptKeys,
} from './settings-command';

/**
 * Sets or clears where failure alerts go, then re-reads the current choice.
 * An unconfirmed attempt must be retried exactly (same key) before a
 * different choice is sent.
 */
export function useFailureNotificationCommands({
  apiClient,
  userId,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>) {
  const queryClient = useQueryClient();
  const commands = useCommandAttemptKeys();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function updatePolicy(destinationId?: string): Promise<boolean> {
    if (pendingRef.current) return false;
    const clear = destinationId === undefined;
    const scope = `policy:${workflowId}`;
    const intent = clear ? 'clear' : `destination:${destinationId}`;
    const attempt = commands.begin(scope, intent);
    if (attempt.kind === 'refused') {
      setError(attempt.message);
      return false;
    }
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (clear)
        await clearFailureNotificationPolicy(
          apiClient,
          workspaceId,
          workflowId,
          attempt.idempotencyKey,
        );
      else
        await setFailureNotificationPolicy({
          apiClient,
          workspaceId,
          workflowId,
          destinationId,
          idempotencyKey: attempt.idempotencyKey,
        });
      commands.complete(scope, intent);
      return true;
    } catch (cause) {
      if (!isUnconfirmedCommand(cause)) commands.complete(scope, intent);
      setError(
        settingsCommandError(
          cause,
          clear ? 'turning failure alerts off' : 'changing where alerts go',
        ),
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
      // The current choice is authoritative after success and shows whether
      // an unconfirmed attempt went through.
      void queryClient.invalidateQueries({
        queryKey: workflowSettingsKeys.failurePolicy(
          userId,
          workspaceId,
          workflowId,
        ),
      });
    }
  }

  return { pending, error, updatePolicy };
}
