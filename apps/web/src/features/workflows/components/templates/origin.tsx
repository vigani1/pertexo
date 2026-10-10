import { useQuery } from '@tanstack/react-query';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { workflowTemplateOriginQueryOptions } from '../../data/origin/queries';
import { useTemplateOriginLifetime } from './use-origin-lifetime';

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
  // The origin is a quiet note: nothing shows until one is known.
  const origin = canRead && !denied ? query.data?.templateOrigin : undefined;
  if (origin === undefined || origin === null) return null;
  return (
    <p
      className="text-xs text-muted-foreground"
      title="Historical basis only; later edits are independent and not checked against the template."
    >
      Based on template {origin.templateId} v{origin.templateVersion}
      {origin.derivation === 'inherited' ? ' (inherited)' : ''}
    </p>
  );
}
