import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  requestWorkspaceDeletion,
  restoreWorkspaceDeletion,
} from '../workspaces.api';

type LifecycleIntent =
  | Readonly<{ command: 'request-deletion'; reason: string }>
  | Readonly<{ command: 'restore' }>;

type LifecycleAttempt = Readonly<{
  intent: LifecycleIntent;
  idempotencyKey: string;
}>;

export function useWorkspaceLifecycleCommand({
  apiClient,
  workspaceId,
  onAccepted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  onAccepted: (operationId: string) => void;
}>) {
  const [error, setError] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const attempt = useRef<LifecycleAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workspace-lifecycle-command');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) owner.current = undefined;
    };
  }, [apiClient, workspaceId]);

  const mutation = useMutation({
    mutationFn: (current: LifecycleAttempt) =>
      current.intent.command === 'request-deletion'
        ? requestWorkspaceDeletion(apiClient, workspaceId, {
            reason: current.intent.reason,
            idempotencyKey: current.idempotencyKey,
          })
        : restoreWorkspaceDeletion(
            apiClient,
            workspaceId,
            current.idempotencyKey,
          ),
  });

  async function submit(current: LifecycleAttempt) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined || mutation.isPending) return false;
    setError(undefined);
    setRetryAvailable(false);
    attempt.current = current;
    try {
      const operation = await mutation.mutateAsync(current);
      if (owner.current !== submissionOwner) return false;
      attempt.current = undefined;
      onAccepted(operation.id);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      const uncertain = isUncertain(cause);
      if (!uncertain) attempt.current = undefined;
      setRetryAvailable(uncertain);
      setError(lifecycleCommandError(cause, current.intent.command));
      return false;
    }
  }

  function start(intent: LifecycleIntent) {
    if (mutation.isPending || retryAvailable) return Promise.resolve(false);
    return submit({ intent, idempotencyKey: crypto.randomUUID() });
  }

  function retry() {
    const current = attempt.current;
    return current === undefined ? Promise.resolve(false) : submit(current);
  }

  function dismissUncertain() {
    attempt.current = undefined;
    setRetryAvailable(false);
    setError(undefined);
  }

  return {
    dismissUncertain,
    error,
    pending: mutation.isPending,
    retry,
    retryAvailable,
    start,
  };
}

function isUncertain(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'protocol')
  );
}

function lifecycleCommandError(
  error: unknown,
  command: LifecycleIntent['command'],
): string {
  const action =
    command === 'request-deletion'
      ? 'request deletion'
      : 'restore the workspace';
  if (isUncertain(error))
    return `The result is uncertain. Retry to ${action} with the same command key.`;
  if (isApiError(error) && error.status === 403)
    return `You no longer have permission to ${action}.`;
  if (isApiError(error) && error.status === 409)
    return 'The workspace state changed. Refresh before trying again.';
  return `Could not ${action}.`;
}
