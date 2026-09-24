import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
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

/**
 * Deletion and restore requests. An unconfirmed request keeps its exact
 * reason and key until it is retried or dismissed.
 */
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
      const uncertain = isUncertainOutcome(cause);
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

function lifecycleCommandError(
  error: unknown,
  command: LifecycleIntent['command'],
): string {
  const subject =
    command === 'request-deletion' ? 'the deletion request' : 'the restore';
  if (isUncertainOutcome(error))
    return `We couldn’t confirm whether ${subject} went through. Try again — it’s the same request, so it can’t run twice.`;
  if (isApiError(error) && error.status === 409)
    return 'The workspace changed meanwhile. Reload the page to see where it stands.';
  return describeCommandError(
    error,
    command === 'request-deletion'
      ? 'requesting deletion'
      : 'restoring the workspace',
  );
}
