import { workflowTemplateOriginProjectionResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import type { ApiClient } from '@/lib/api/client';

export function readWorkflowTemplateOrigin(
  apiClient: ApiClient,
  workspaceId: string,
  workflowId: string,
  signal: AbortSignal,
) {
  return apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}?include=templateOrigin`,
    signal,
    headers: { 'Cache-Control': 'no-store' },
    response: {
      kind: 'json',
      decode: (value) =>
        workflowTemplateOriginProjectionResponseSchema.parse(value),
    },
  });
}
