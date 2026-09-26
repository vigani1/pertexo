import { useState } from 'react';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useRevokeAccountSession,
  useRevokeOtherAccountSessions,
} from '../../account-security.mutations';

export type SessionEnding =
  | Readonly<{ kind: 'one'; id: string; label: string }>
  | Readonly<{ kind: 'others' }>;

/**
 * Signing devices out: which sign-out is being confirmed (one device or
 * every other one), the request behind it, and the toast once it's done.
 */
export function useSessionEnding(apiClient: ApiClient, userId: string) {
  const revoke = useRevokeAccountSession(apiClient, userId);
  const revokeOthers = useRevokeOtherAccountSessions(apiClient, userId);
  const notifications = useNotifications();
  const [ending, setEnding] = useState<SessionEnding>();
  const busy = revoke.isPending || revokeOthers.isPending;

  /** Asks to confirm signing out `next`, clearing an earlier failure. */
  function ask(next: SessionEnding) {
    revoke.reset();
    revokeOthers.reset();
    setEnding(next);
  }

  function cancel() {
    if (busy) return;
    revoke.reset();
    revokeOthers.reset();
    setEnding(undefined);
  }

  async function confirm() {
    if (ending?.kind === 'one') {
      const { label } = ending;
      await revoke.mutateAsync(ending.id);
      setEnding(undefined);
      notifications.success({ title: `Signed out of ${label}` });
    }
    if (ending?.kind === 'others') {
      const result = await revokeOthers.mutateAsync();
      setEnding(undefined);
      notifications.success({
        title:
          result.revokedCount === 1
            ? 'Signed out of 1 other device'
            : `Signed out of ${String(result.revokedCount)} other devices`,
      });
    }
  }

  return {
    ending,
    busy,
    error: revoke.error ?? revokeOthers.error,
    ask,
    cancel,
    confirm,
  } as const;
}
