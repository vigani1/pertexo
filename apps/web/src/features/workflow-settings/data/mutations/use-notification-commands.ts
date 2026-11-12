import { useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@/lib/api/client';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import {
  clearFailureNotificationPolicy,
  setFailureNotificationPolicy,
} from '../workflow-settings.api';
import { workflowSettingsKeys } from '../workflow-settings.queries';

type PolicyChange =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'set'; destinationId: string }>;

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
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (intent: PolicyChange, key) =>
      intent.kind === 'clear'
        ? clearFailureNotificationPolicy(
            apiClient,
            workspaceId,
            workflowId,
            key,
          )
        : setFailureNotificationPolicy({
            apiClient,
            workspaceId,
            workflowId,
            destinationId: intent.destinationId,
            idempotencyKey: key,
          }),
    refresh: () =>
      cache.invalidateQueries({
        queryKey: workflowSettingsKeys.failurePolicy(
          userId,
          workspaceId,
          workflowId,
        ),
      }),
  });
  async function updatePolicy(destinationId?: string) {
    if (mutation.isPending) return false;
    try {
      await mutation.mutateAsync(
        destinationId === undefined
          ? { kind: 'clear' }
          : { kind: 'set', destinationId },
      );
      return true;
    } catch {
      return false;
    }
  }
  return {
    pending: mutation.isPending,
    error: mutation.isError
      ? lowEffectError(mutation.error, 'changing failure alerts')
      : undefined,
    updatePolicy,
  };
}
