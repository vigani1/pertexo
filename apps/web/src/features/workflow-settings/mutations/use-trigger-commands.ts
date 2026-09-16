import type { WebhookManagementCommandResponse } from '@pertexo/contracts/schemas/webhooks';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { commandWebhook, setScheduleEnabled } from '../workflow-settings.api';
import { workflowSettingsKeys } from '../workflow-settings.queries';
import {
  settingsCommandError,
  isUncertainSettingsCommand,
  unresolvedCommandMessage,
  useCommandAttemptKeys,
} from './settings-command';

export function useScheduleCommand({
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
  const [pendingTriggerId, setPendingTriggerId] = useState<string>();
  const [error, setError] = useState<string>();

  async function setEnabled(
    triggerId: string,
    enabled: boolean,
    observedEnabled: boolean,
  ) {
    if (pendingRef.current) return false;
    const scope = `schedule:${triggerId}`;
    commands.resolveObserved(scope, String(observedEnabled));
    const attempt = commands.begin(scope, String(enabled));
    if (attempt === undefined) {
      setError(unresolvedCommandMessage);
      return false;
    }
    pendingRef.current = true;
    setPendingTriggerId(triggerId);
    setError(undefined);
    try {
      await setScheduleEnabled(
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        enabled,
        attempt.key,
      );
      commands.complete(scope, String(enabled));
      await queryClient.invalidateQueries({
        queryKey: workflowSettingsKeys.schedules(
          userId,
          workspaceId,
          workflowId,
        ),
      });
      return true;
    } catch (cause) {
      if (!isUncertainSettingsCommand(cause))
        commands.complete(scope, String(enabled));
      setError(
        settingsCommandError(
          cause,
          `${enabled ? 'enable' : 'disable'} this schedule`,
        ),
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPendingTriggerId(undefined);
    }
  }

  return { pendingTriggerId, error, setEnabled };
}

export type IssuedWebhookCredentials = Readonly<{
  triggerId: string;
  response: WebhookManagementCommandResponse;
}>;

export type WebhookCommandOutcome =
  'blocked' | 'complete' | 'credentials' | 'failed';

type WebhookCommand = 'provision' | 'rotate-endpoint' | 'rotate-secret';

type WebhookCommandAttempt = Readonly<{
  triggerId: string;
  command: WebhookCommand;
  endpointKey: string;
  intent: string;
  idempotencyKey: string;
}>;

export type UncertainWebhookCommand = Readonly<{
  triggerId: string;
  command: WebhookCommand;
}>;

export function useWebhookCommand({
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
  const locked = useRef(false);
  const [pendingTriggerId, setPendingTriggerId] = useState<string>();
  const [credentials, setCredentials] = useState<IssuedWebhookCredentials>();
  const unresolvedAttemptRef = useRef<WebhookCommandAttempt | undefined>(
    undefined,
  );
  const [unresolvedAttempt, setUnresolvedAttempt] =
    useState<UncertainWebhookCommand>();
  const [error, setError] = useState<string>();

  async function execute(
    triggerId: string,
    command: WebhookCommand,
    endpointKey: string,
  ) {
    if (locked.current || unresolvedAttemptRef.current !== undefined)
      return 'blocked' satisfies WebhookCommandOutcome;
    const scope = `webhook:${triggerId}`;
    const intent = `${command}:${endpointKey.trim()}`;
    const attempt = commands.begin(scope, intent);
    if (attempt === undefined) {
      setError(unresolvedCommandMessage);
      return 'blocked' satisfies WebhookCommandOutcome;
    }
    return dispatch({
      triggerId,
      command,
      endpointKey: endpointKey.trim(),
      intent,
      idempotencyKey: attempt.key,
    });
  }

  async function retryUncertain() {
    const attempt = unresolvedAttemptRef.current;
    if (locked.current || attempt === undefined)
      return 'blocked' satisfies WebhookCommandOutcome;
    return dispatch(attempt);
  }

  async function dispatch(attempt: WebhookCommandAttempt) {
    locked.current = true;
    let awaitingAcknowledgement = false;
    const scope = `webhook:${attempt.triggerId}`;
    setPendingTriggerId(attempt.triggerId);
    setError(undefined);
    try {
      const input =
        attempt.command === 'rotate-secret'
          ? {
              command: attempt.command,
              endpointKey: attempt.endpointKey,
              idempotencyKey: attempt.idempotencyKey,
            }
          : {
              command: attempt.command,
              idempotencyKey: attempt.idempotencyKey,
            };
      const response = await commandWebhook(
        apiClient,
        workspaceId,
        workflowId,
        attempt.triggerId,
        input,
      );
      commands.complete(scope, attempt.intent);
      unresolvedAttemptRef.current = undefined;
      setUnresolvedAttempt(undefined);
      if (response.endpointKey || response.signingSecret) {
        awaitingAcknowledgement = true;
        setCredentials({ triggerId: attempt.triggerId, response });
      }
      try {
        await queryClient.invalidateQueries({
          queryKey: workflowSettingsKeys.webhooks(
            userId,
            workspaceId,
            workflowId,
          ),
        });
      } catch {
        setError(
          'The command succeeded, but the webhook list could not be refreshed.',
        );
      }
      return (
        awaitingAcknowledgement ? 'credentials' : 'complete'
      ) satisfies WebhookCommandOutcome;
    } catch (cause) {
      if (isUncertainSettingsCommand(cause)) {
        unresolvedAttemptRef.current = attempt;
        setUnresolvedAttempt({
          triggerId: attempt.triggerId,
          command: attempt.command,
        });
      } else {
        commands.complete(scope, attempt.intent);
        unresolvedAttemptRef.current = undefined;
        setUnresolvedAttempt(undefined);
      }
      setError(
        settingsCommandError(cause, attempt.command.replaceAll('-', ' ')),
      );
      return 'failed' satisfies WebhookCommandOutcome;
    } finally {
      setPendingTriggerId(undefined);
      if (!awaitingAcknowledgement) locked.current = false;
    }
  }

  function acknowledgeCredentials() {
    setCredentials(undefined);
    locked.current = false;
  }

  return {
    pendingTriggerId,
    blocked:
      pendingTriggerId !== undefined ||
      credentials !== undefined ||
      unresolvedAttempt !== undefined,
    credentials,
    unresolvedAttempt,
    error,
    execute,
    retryUncertain,
    acknowledgeCredentials,
  };
}
