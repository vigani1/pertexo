import { useQueryClient } from '@tanstack/react-query';
import {
  useLowEffectMutation,
  lowEffectError,
} from '@/lib/api/commands/low-effect-mutation';
import { isUnauthenticated } from '@/features/auth/session/identity.public';
import { isApiError } from '@/lib/api/error';
import type { ApiClient } from '@/lib/api/client';
import { leaveWorkspace } from '../../workspaces.api';
import { directoryMembershipFeedback } from '../../../model/directory-membership';

export function useLeaveWorkspaceCommand({
  apiClient,
  workspaceId,
  onLeft,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  onLeft: (confirmed: boolean) => void | Promise<void>;
}>) {
  const cache = useQueryClient();
  const mutation = useLowEffectMutation({
    send: (_input: undefined, key) =>
      leaveWorkspace(apiClient, workspaceId, key),
    refresh: () => cache.invalidateQueries(),
  });
  async function finish(confirmed: boolean) {
    cache.clear();
    await onLeft(confirmed);
  }
  async function start() {
    if (mutation.isPending) return false;
    let completion: Promise<void> | undefined;
    try {
      await mutation.mutateAsync(undefined, {
        onSuccess: () => {
          completion = finish(true);
        },
        onError: (cause) => {
          if (isUnauthenticated(cause)) completion = finish(false);
        },
      });
      if (completion === undefined) return false;
      await completion;
      return true;
    } catch {
      await completion;
      return false;
    }
  }
  const error = !mutation.isError
    ? undefined
    : (directoryMembershipFeedback(mutation.error) ??
      (isApiError(mutation.error) && mutation.error.status === 403
        ? 'The owner can’t leave. Make another member the owner from Team first.'
        : lowEffectError(mutation.error, 'leaving the workspace')));
  return { start, pending: mutation.isPending, error, dismiss: mutation.reset };
}
