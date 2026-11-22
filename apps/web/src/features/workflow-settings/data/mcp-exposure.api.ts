import {
  workflowMcpExposureRequestSchema,
  workflowMcpExposureResponseSchema,
  workflowMcpSettingsSchema,
  type WorkflowMcpExposureRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';

export type McpSettingsScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>;

const path = ({ workspaceId, workflowId }: McpSettingsScope): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/mcp`;

export function getMcpExposure(scope: McpSettingsScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: path(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workflowMcpSettingsSchema.parse(value),
    },
  });
}

export function putMcpExposure(
  scope: McpSettingsScope,
  request: WorkflowMcpExposureRequest,
) {
  return scope.apiClient.request({
    path: path(scope),
    method: 'PUT',
    body: workflowMcpExposureRequestSchema.parse(request),
    response: {
      kind: 'json',
      decode: (value) => workflowMcpExposureResponseSchema.parse(value),
    },
  });
}
