import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';
import { subscribeSessionChanges } from '@/features/auth/session-sync.public';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  workflowTemplateOriginKey,
  workflowTemplateOriginQueryOptions,
} from '../../workflow-origin.queries';

export function WorkflowTemplateOrigin(
  props: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
  }>,
) {
  return (
    <OriginSnapshot
      key={`${props.userId}:${props.workspace.id}:${props.workflowId}`}
      {...props}
    />
  );
}

function OriginSnapshot({
  apiClient,
  userId,
  workspace,
  workflowId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
}>) {
  const queryClient = useQueryClient();
  const [denied, setDenied] = useState(false);
  const canRead = workspace.capabilities.includes('workflow:read');
  const query = useQuery({
    ...workflowTemplateOriginQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId,
    ),
    enabled: canRead && !denied,
  });
  useEffect(() => {
    const queryKey = workflowTemplateOriginKey(
      userId,
      workspace.id,
      workflowId,
    );
    const clear = () => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    };
    const retire = () => {
      setDenied(true);
      clear();
    };
    const unsubscribeSession = subscribeSessionChanges(retire);
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.query.queryKey as readonly unknown[];
      if (
        key[0] === 'identity' &&
        key[1] === userId &&
        key[2] === 'workspace' &&
        key[3] === workspace.id &&
        isApiError(event.query.state.error) &&
        [401, 403, 404].includes(event.query.state.error.status ?? 0)
      )
        retire();
    });
    if (!canRead) queueMicrotask(retire);
    return () => {
      unsubscribeSession();
      unsubscribeCache();
      clear();
    };
  }, [canRead, queryClient, userId, workspace.id, workflowId]);
  if (!canRead || denied)
    return (
      <p className="text-xs text-muted-foreground">
        Template origin unavailable: access changed.
      </p>
    );
  if (query.isError)
    return (
      <p className="text-xs text-muted-foreground">
        Template origin unavailable.{' '}
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry origin read
        </Button>
      </p>
    );
  if (query.isPending || query.isFetching)
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Reading historical template origin…
      </p>
    );
  if (query.data.templateOrigin === null)
    return (
      <p className="text-xs text-muted-foreground">
        No recorded template origin.
      </p>
    );
  const origin = query.data.templateOrigin;
  return (
    <p className="text-xs text-muted-foreground">
      Originally based on {origin.templateId}, version {origin.templateVersion}
      {origin.derivation === 'inherited' ? ' (inherited)' : ''}. Historical
      basis only; later edits are independent, not verified for equivalence or
      safety.
    </p>
  );
}
