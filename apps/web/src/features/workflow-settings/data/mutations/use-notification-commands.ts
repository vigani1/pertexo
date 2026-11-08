import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import { useCommandAttempt } from '@/lib/api/commands/use-command-attempt';
import {
  isUnconfirmedCommand,
  newCommandKey,
  RETRY_WINDOW_ENDED,
  type CommandKey,
} from '@/lib/api/commands/command-retry';
import {
  clearFailureNotificationPolicy,
  setFailureNotificationPolicy,
} from '../workflow-settings.api';
import { workflowSettingsKeys } from '../workflow-settings.queries';
import { settingsCommandError } from './settings-command';

type PolicyChange =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'set'; destinationId: string }>;
type PolicyAttempt = CommandKey & Readonly<{ intent: PolicyChange }>;
type PolicyCommandState =
  | Readonly<{ kind: 'ready' | 'sending' }>
  | Readonly<{ kind: 'uncertain' | 'retrying' | 'failed'; message: string }>;

/** A retained policy change stays recoverable independently of the current policy. */
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
  const attempt = useCommandAttempt<PolicyAttempt>();
  const pendingRef = useRef(false);
  const [state, setState] = useState<PolicyCommandState>({ kind: 'ready' });

  async function send(intent: PolicyChange): Promise<boolean> {
    if (pendingRef.current) return false;
    const retained = attempt.current();
    if (retained !== undefined && !samePolicyChange(retained.intent, intent)) {
      setState({
        kind: 'uncertain',
        message:
          'An earlier change is still unconfirmed. Retry the same alert change before making a different choice.',
      });
      return false;
    }
    pendingRef.current = true;
    setState(
      retained === undefined
        ? { kind: 'sending' }
        : { kind: 'retrying', message: 'Confirming the earlier alert change…' },
    );
    let dispatched = false;
    try {
      const command = await attempt.getOrCreate(() => ({
        ...newCommandKey(),
        intent,
      }));
      if (command === undefined) {
        setState({ kind: 'uncertain', message: RETRY_WINDOW_ENDED });
        return false;
      }
      dispatched = true;
      if (command.intent.kind === 'clear')
        await clearFailureNotificationPolicy(
          apiClient,
          workspaceId,
          workflowId,
          command.idempotencyKey,
        );
      else
        await setFailureNotificationPolicy({
          apiClient,
          workspaceId,
          workflowId,
          destinationId: command.intent.destinationId,
          idempotencyKey: command.idempotencyKey,
        });
      attempt.clear();
      setState({ kind: 'ready' });
      return true;
    } catch (cause) {
      const uncertain = isUnconfirmedCommand(cause);
      if (!uncertain) attempt.clear();
      setState({
        kind: uncertain ? 'uncertain' : 'failed',
        message: settingsCommandError(
          cause,
          intent.kind === 'clear'
            ? 'turning failure alerts off'
            : 'changing where alerts go',
        ),
      });
      return false;
    } finally {
      pendingRef.current = false;
      if (dispatched)
        void queryClient.invalidateQueries({
          queryKey: workflowSettingsKeys.failurePolicy(
            userId,
            workspaceId,
            workflowId,
          ),
        });
    }
  }

  return {
    pending: state.kind === 'sending' || state.kind === 'retrying',
    uncertain: state.kind === 'uncertain' || state.kind === 'retrying',
    error: 'message' in state ? state.message : undefined,
    expired: attempt.expired,
    updatePolicy: (destinationId?: string) =>
      send(
        destinationId === undefined
          ? { kind: 'clear' }
          : { kind: 'set', destinationId },
      ),
    retry: async () => {
      const retained = attempt.current();
      return retained === undefined ? false : send(retained.intent);
    },
    startNewAttempt: () => {
      if (pendingRef.current) return;
      attempt.clear();
      setState({ kind: 'ready' });
    },
  };
}

function samePolicyChange(left: PolicyChange, right: PolicyChange): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'clear' ||
      (right.kind === 'set' && left.destinationId === right.destinationId))
  );
}
