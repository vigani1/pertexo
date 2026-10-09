import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { workflowTemplateOriginQueryOptions } from '../../data/workflow-origin.queries';
import { useTemplateOriginLifetime } from './use-template-origin-lifetime';

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
  const canRead = workspace.capabilities.includes('workflow:read');
  const denied = useTemplateOriginLifetime(
    userId,
    workspace.id,
    workflowId,
    canRead,
  );
  const query = useQuery({
    ...workflowTemplateOriginQueryOptions(
      apiClient,
      userId,
      workspace.id,
      workflowId,
    ),
    enabled: canRead && !denied,
  });
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
