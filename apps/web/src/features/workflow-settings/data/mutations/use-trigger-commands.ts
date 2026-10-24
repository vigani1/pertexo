import type {
  WebhookManagementCommandResponse,
  WebhookAuthentication,
} from '@pertexo/contracts';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workflowKeys } from '@/features/workflows/queries.public';
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

  async function setEnabled({
    triggerId,
    enabled,
    observedEnabled,
  }: Readonly<{
    triggerId: string;
    enabled: boolean;
    observedEnabled: boolean;
  }>) {
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
      await setScheduleEnabled({
        apiClient,
        workspaceId,
        workflowId,
        triggerId,
        enabled,
        idempotencyKey: attempt.key,
      });
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
          `turning this schedule ${enabled ? 'on' : 'off'}`,
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
  command: WebhookCommand;
  response: WebhookManagementCommandResponse;
}>;

export type WebhookCommandOutcome =
  'blocked' | 'complete' | 'credentials' | 'failed' | 'updated';

export type WebhookCommand =
  'provision' | 'rotate-endpoint' | 'rotate-secret' | 'authentication';

/** What each command does, as the noun phrase used in feedback. */
export const WEBHOOK_ACTIONS: Readonly<Record<WebhookCommand, string>> = {
  provision: 'creating the endpoint',
  authentication: 'updating authentication',
  'rotate-endpoint': 'rotating the URL',
  'rotate-secret': 'rotating the webhook secret',
};

type WebhookCommandAttempt = Readonly<{
  triggerId: string;
  command: WebhookCommand;
  endpointKey: string;
  authentication?: WebhookAuthentication;
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
  const [pending, setPending] = useState<UncertainWebhookCommand>();
  const [credentials, setCredentials] = useState<IssuedWebhookCredentials>();
  const unresolvedAttemptRef = useRef<WebhookCommandAttempt | undefined>(
    undefined,
  );
  const [unresolvedAttempt, setUnresolvedAttempt] =
    useState<UncertainWebhookCommand>();
  // The failure belongs to one webhook, so its card can show it by its button.
  const [error, setError] =
    useState<Readonly<{ triggerId: string; message: string }>>();

  async function execute(
    triggerId: string,
    command: WebhookCommand,
    endpointKey: string,
    authentication?: WebhookAuthentication,
  ) {
    if (locked.current || unresolvedAttemptRef.current !== undefined)
      return 'blocked' satisfies WebhookCommandOutcome;
    const scope = `webhook:${triggerId}`;
    const intent = `${command}:${endpointKey.trim()}:${authentication === undefined ? '' : JSON.stringify(authentication)}`;
    const attempt = commands.begin(scope, intent);
    if (attempt === undefined) {
      setError({ triggerId, message: unresolvedCommandMessage });
      return 'blocked' satisfies WebhookCommandOutcome;
    }
    return dispatch({
      triggerId,
      command,
      endpointKey: endpointKey.trim(),
      ...(authentication === undefined ? {} : { authentication }),
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
    setPending({ triggerId: attempt.triggerId, command: attempt.command });
    setError(undefined);
    try {
      let input: Parameters<typeof commandWebhook>[0]['input'];
      if (attempt.command === 'authentication') {
        if (attempt.authentication === undefined)
          throw new Error('Webhook authentication intent is missing');
        input = {
          command: attempt.command,
          authentication: attempt.authentication,
          idempotencyKey: attempt.idempotencyKey,
        };
      } else if (attempt.command === 'rotate-secret') {
        input = {
          command: attempt.command,
          endpointKey: attempt.endpointKey,
          idempotencyKey: attempt.idempotencyKey,
        };
      } else
        input = {
          command: attempt.command,
          idempotencyKey: attempt.idempotencyKey,
        };
      const response = await commandWebhook({
        apiClient,
        workspaceId,
        workflowId,
        triggerId: attempt.triggerId,
        input,
      });
      commands.complete(scope, attempt.intent);
      unresolvedAttemptRef.current = undefined;
      setUnresolvedAttempt(undefined);
      if (response.endpointKey || response.signingSecret) {
        awaitingAcknowledgement = true;
        setCredentials({
          triggerId: attempt.triggerId,
          command: attempt.command,
          response,
        });
      }
      try {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: workflowSettingsKeys.webhooks(
              userId,
              workspaceId,
              workflowId,
            ),
          }),
          queryClient.invalidateQueries({
            queryKey: workflowKeys.scope(userId, workspaceId),
          }),
        ]);
      } catch {
        setError({
          triggerId: attempt.triggerId,
          message:
            'That worked, but the webhook list couldn’t refresh. Reload to see its latest state.',
        });
      }
      if (awaitingAcknowledgement)
        return 'credentials' satisfies WebhookCommandOutcome;
      return (
        response.replayed ? 'complete' : 'updated'
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
      setError({
        triggerId: attempt.triggerId,
        message: settingsCommandError(cause, WEBHOOK_ACTIONS[attempt.command]),
      });
      return 'failed' satisfies WebhookCommandOutcome;
    } finally {
      setPending(undefined);
      if (!awaitingAcknowledgement) locked.current = false;
    }
  }

  function acknowledgeCredentials() {
    setCredentials(undefined);
    locked.current = false;
  }

  return {
    pending,
    blocked:
      pending !== undefined ||
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
