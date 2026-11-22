import { queryOptions } from '@tanstack/react-query';
import { QUERY_FRESHNESS } from '@/lib/api/query-timings';
import { getMcpExposure, type McpSettingsScope } from './mcp-exposure.api';

export const mcpExposureKey = ({
  userId,
  workspaceId,
  workflowId,
}: McpSettingsScope) =>
  [
    'identity',
    userId,
    'workspace',
    workspaceId,
    'workflow-mcp',
    workflowId,
  ] as const;

export function mcpExposureQuery(scope: McpSettingsScope) {
  return queryOptions({
    queryKey: mcpExposureKey(scope),
    queryFn: ({ signal }) => getMcpExposure(scope, signal),
    staleTime: QUERY_FRESHNESS.none,
  });
}
