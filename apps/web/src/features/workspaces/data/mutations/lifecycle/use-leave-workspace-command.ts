import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/session/session-identity.public';
import { isApiError } from '@/lib/api/error';
import { describeCommandError, isUncertainOutcome } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { leaveWorkspace } from '../../workspaces.api';

/** Why leaving failed, in words; the owner is told what to do first. */
function leaveFailure(cause: unknown): string {
  if (isUncertainOutcome(cause))
    return 'We couldn’t confirm whether you left. Try again — it’s the same request, so it can’t happen twice.';
  if (isApiError(cause) && cause.status === 403)
    return 'The owner can’t leave. Make another member the owner from Team first.';
  return describeCommandError(cause, 'leaving the workspace');
}

/**
 * Leaves the workspace (ADR 047). Every session of the person ends with it,
 * so success and a later "session ended" both mean the person is out; an
 * unconfirmed attempt keeps its exact key for the retry.
 */
export function useLeaveWorkspaceCommand({
  apiClient,
  workspaceId,
  onLeft,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  /** `confirmed` is false when only the ended session says so. */
  onLeft: (confirmed: boolean) => void | Promise<void>;
}>) {
  const queryClient = useQueryClient();
  const owner = useRef<symbol | undefined>(undefined);
  const activeSubmission = useRef<symbol | undefined>(undefined);
  const key = useRef<string | undefined>(undefined);
  const [failure, setFailure] = useState<
    Readonly<{ message: string; uncertain: boolean }> | undefined
  >();
  useEffect(() => {
    const currentOwner = Symbol('workspace-leave');
    owner.current = currentOwner;
    return () => {
      if (owner.current === currentOwner) {
        owner.current = undefined;
        activeSubmission.current = undefined;
      }
    };
  }, [apiClient, workspaceId]);
  const mutation = useMutation({
    mutationFn: (idempotencyKey: string) =>
      leaveWorkspace(apiClient, workspaceId, idempotencyKey),
    onMutate: () => owner.current,
    onSuccess: (_result, _key, submissionOwner) =>
      finish(true, submissionOwner),
  });

  async function finish(
    confirmed: boolean,
    submissionOwner: symbol | undefined,
  ) {
    if (submissionOwner === undefined || owner.current !== submissionOwner)
      return;
    // Leaving ends every session, so no protected snapshot remains valid.
    await queryClient.cancelQueries();
    if (owner.current !== submissionOwner) return;
    queryClient.clear();
    if (owner.current === submissionOwner) await onLeft(confirmed);
  }

  async function send(idempotencyKey: string): Promise<boolean> {
    const submissionOwner = owner.current;
    if (submissionOwner === undefined || activeSubmission.current !== undefined)
      return false;
    const submission = Symbol('workspace-leave-submission');
    activeSubmission.current = submission;
    key.current = idempotencyKey;
    setFailure(undefined);
    try {
      await mutation.mutateAsync(idempotencyKey);
      return true;
    } catch (cause) {
      if (owner.current !== submissionOwner) return false;
      if (isUnauthenticated(cause)) {
        await finish(false, submissionOwner);
        return false;
      }
      const uncertain = isUncertainOutcome(cause);
      if (!uncertain) key.current = undefined;
      setFailure({ message: leaveFailure(cause), uncertain });
      return false;
    } finally {
      if (activeSubmission.current === submission)
        activeSubmission.current = undefined;
    }
  }

  return {
    pending: mutation.isPending,
    error: failure?.message,
    retryAvailable: failure?.uncertain === true,
    start: () =>
      failure?.uncertain === true
        ? Promise.resolve(false)
        : send(crypto.randomUUID()),
    retry: () =>
      key.current === undefined ? Promise.resolve(false) : send(key.current),
    dismiss: () => {
      key.current = undefined;
      setFailure(undefined);
    },
  };
}
