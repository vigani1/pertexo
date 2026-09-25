import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { isUnauthenticated } from '@/features/auth/session-identity.public';
import { isApiError } from '@/lib/api/api-error';
import {
  describeCommandError,
  isUncertainOutcome,
} from '@/lib/api/api-error-copy';
import type { ApiClient } from '@/lib/api/client';
import { leaveWorkspace } from '../workspaces.api';

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
  onLeft: (confirmed: boolean) => void;
}>) {
  const key = useRef<string | undefined>(undefined);
  const [failure, setFailure] = useState<
    Readonly<{ message: string; uncertain: boolean }> | undefined
  >();
  const mutation = useMutation({
    mutationFn: (idempotencyKey: string) =>
      leaveWorkspace(apiClient, workspaceId, idempotencyKey),
  });

  async function send(idempotencyKey: string): Promise<boolean> {
    if (mutation.isPending) return false;
    key.current = idempotencyKey;
    setFailure(undefined);
    try {
      await mutation.mutateAsync(idempotencyKey);
      onLeft(true);
      return true;
    } catch (cause) {
      if (isUnauthenticated(cause)) {
        onLeft(false);
        return false;
      }
      const uncertain = isUncertainOutcome(cause);
      if (!uncertain) key.current = undefined;
      setFailure({ message: leaveFailure(cause), uncertain });
      return false;
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
