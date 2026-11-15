import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectionKeys } from './connections.queries';

/**
 * Drops what this person may no longer read: every connection read when
 * they can't browse connections, or only the usage reads (which name
 * workflows) when they can't read workflows.
 */
export function useConnectionReadScope({
  userId,
  workspaceId,
  canBrowse,
  canReadUsage,
}: Readonly<{
  userId: string;
  workspaceId: string;
  canBrowse: boolean;
  canReadUsage: boolean;
}>) {
  const cache = useQueryClient();
  useEffect(() => {
    if (canBrowse && canReadUsage) return;
    const queryKey = canBrowse
      ? connectionKeys.usages(userId, workspaceId)
      : connectionKeys.scope(userId, workspaceId);
    void cache.cancelQueries({ queryKey }).then(() => {
      cache.removeQueries({ queryKey });
    });
  }, [cache, canBrowse, canReadUsage, userId, workspaceId]);
}
