import { useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  clearFailureNotificationPolicy,
  setFailureNotificationPolicy,
} from '../workflow-settings.api';
import {
  settingsCommandError,
  isUncertainSettingsCommand,
  unresolvedCommandMessage,
  useCommandAttemptKeys,
} from './settings-command';

export function useFailureNotificationCommands({
  apiClient,
  workspaceId,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  workflowId: string;
}>) {
  const commands = useCommandAttemptKeys();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();

  async function updatePolicy(destinationId?: string) {
    if (pendingRef.current) return false;
    const clear = destinationId === undefined;
    const scope = `policy:${workflowId}`;
    const intent = clear ? 'clear' : `destination:${destinationId}`;
    const attempt = commands.begin(scope, intent);
    if (attempt === undefined) {
      setError(unresolvedCommandMessage);
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
          attempt.key,
        );
      else
        await setFailureNotificationPolicy(
          apiClient,
          workspaceId,
          workflowId,
          destinationId,
          attempt.key,
        );
      commands.complete(scope, intent);
      setResult(
        clear
          ? 'Failure notification policy cleared.'
          : 'Failure notification policy updated.',
      );
      return true;
    } catch (cause) {
      if (!isUncertainSettingsCommand(cause)) commands.complete(scope, intent);
      setError(
        settingsCommandError(
          cause,
          clear ? 'clear the policy' : 'set the policy',
        ),
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    error,
    result,
    updatePolicy,
  };
}
