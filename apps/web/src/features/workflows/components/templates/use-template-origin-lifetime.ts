import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import { isApiError } from '@/lib/api/api-error';
import { workflowTemplateOriginKey } from '../../workflow-origin.queries';
import { workflowKeys } from '../../workflows.queries';

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
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.query.queryKey as readonly unknown[];
      const error: unknown = event.query.state.error;
      if (
        key[0] !== 'identity' ||
        key[1] !== userId ||
        key[2] !== 'workspace' ||
        key[3] !== workspaceId ||
        !isApiError(error) ||
        ![401, 403, 404].includes(error.status ?? 0)
      )
        return;
      const exact = (candidate: readonly unknown[]) =>
        key.length === candidate.length &&
        candidate.every((part, index) => part === key[index]);
      if (
        error.status === 401 ||
        key.length === 4 ||
        exact(scopeKey) ||
        exact(detailKey) ||
        exact(originKey)
      )
        retire();
    });
    if (!allowed) queueMicrotask(retire);
    return () => {
      unsubscribeSession();
      unsubscribeCache();
      clear();
    };
  }, [allowed, queryClient, userId, workspaceId, workflowId]);
  return denied;
}
