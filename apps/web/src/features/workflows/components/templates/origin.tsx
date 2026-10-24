import { useQuery } from '@tanstack/react-query';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
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
    className?: string;
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
  className,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  className?: string;
}>) {
  const canRead = workspace.capabilities.includes('workflow:read');
  const denied = useTemplateOriginLifetime({
    userId,
    workspaceId: workspace.id,
    workflowId,
    allowed: canRead,
  });
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
  const title = CURATED_WORKFLOW_TEMPLATES.find(
    (template) => template.templateId === origin.templateId,
  )?.title;
  return (
    <span
      className={className}
      title={`Example version ${String(origin.templateVersion)}. Later edits are this workflow’s own; the example never changes it.`}
    >
      {origin.derivation === 'inherited'
        ? 'Copied from a workflow that started from '
        : 'Started from '}
      {title === undefined ? 'an example' : `the “${title}” example`}
    </span>
  );
}
