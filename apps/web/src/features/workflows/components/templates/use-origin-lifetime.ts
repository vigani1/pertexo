import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeSessionChanges } from '@/features/auth/session/session-sync.public';
import { watchWorkspaceReadDenial } from '@/lib/api/read-denial';
import { workflowTemplateOriginKey } from '../../data/origin/queries';
import { workflowKeys } from '../../data/workflows.queries';

/** One historical projection belongs to one identity/workspace/workflow lifetime.
 * Only denial of that read/root authority retires it; sibling feature and
 * other-workflow denials do not establish that this workflow became unreadable.
 */
export function useTemplateOriginLifetime(
  userId: string,
  workspaceId: string,
  workflowId: string,
  allowed: boolean,
) {
  const queryClient = useQueryClient();
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    const originKey = workflowTemplateOriginKey(
      userId,
      workspaceId,
      workflowId,
    );
    const detailKey = workflowKeys.detail(userId, workspaceId, workflowId);
    const scopeKey = workflowKeys.scope(userId, workspaceId);
    const clear = () => {
      void queryClient.cancelQueries({ queryKey: originKey, exact: true });
      queryClient.removeQueries({ queryKey: originKey, exact: true });
    };
    const retire = () => {
      setDenied(true);
      clear();
    };
    const unsubscribeSession = subscribeSessionChanges(retire);
    const exact = (key: readonly unknown[], candidate: readonly unknown[]) =>
      key.length === candidate.length - 4 &&
      candidate.slice(4).every((part, index) => part === key[index]);
    const unsubscribeCache = watchWorkspaceReadDenial(
      queryClient,
      userId,
      workspaceId,
      ({ key, error }) =>
        error.status === 401 ||
        key.length === 0 ||
        exact(key, scopeKey) ||
        exact(key, detailKey) ||
        exact(key, originKey),
      retire,
    );
    if (!allowed) queueMicrotask(retire);
    return () => {
      unsubscribeSession();
      unsubscribeCache();
      clear();
    };
  }, [allowed, queryClient, userId, workspaceId, workflowId]);
  return denied;
}
