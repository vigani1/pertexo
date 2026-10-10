import type { WorkspaceLifecycleChangeResponse } from '@pertexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/error';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';
import {
  requestWorkspaceDeletion,
  restoreWorkspaceDeletion,
} from '../../workspaces.api';
import { accessibleWorkspacesQueryOptions } from '../../workspaces.queries';

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
  userId,
  onCompleted,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  userId: string;
  onCompleted: (
    change: WorkspaceLifecycleChangeResponse['change'],
  ) => void | Promise<void>;
}>) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [retryAvailable, setRetryAvailable] = useState(false);
  const attempt = useRef<LifecycleAttempt | undefined>(undefined);
  const owner = useRef<symbol | undefined>(undefined);
  const activeSubmission = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    const currentOwner = Symbol('workspace-lifecycle-command');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        activeSubmission.current = undefined;
      }
    };
  }, [apiClient, userId, workspaceId]);

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
    onMutate: () => owner.current,
    onSuccess: async (completed, _attempt, submissionOwner) => {
      if (owner.current !== submissionOwner) return;
      attempt.current = undefined;
      await queryClient.invalidateQueries({
        queryKey: accessibleWorkspacesQueryOptions(apiClient, userId).queryKey,
      });
      if (owner.current === submissionOwner)
        await onCompleted(completed.change);
    },
  });

  async function submit(current: LifecycleAttempt) {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined || activeSubmission.current !== undefined)
      return false;
    const submission = Symbol('workspace-lifecycle-submission');
    activeSubmission.current = submission;
    setError(undefined);
    setRetryAvailable(false);
    attempt.current = current;
    try {
      await mutation.mutateAsync(current);
      return owner.current === submissionOwner;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      const uncertain = isUncertainOutcome(cause);
      if (!uncertain) attempt.current = undefined;
      setRetryAvailable(uncertain);
      setError(lifecycleCommandError(cause, current.intent.command));
      return false;
    } finally {
      if (activeSubmission.current === submission)
        activeSubmission.current = undefined;
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
