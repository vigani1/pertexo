import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkflowMcpExposureRequest } from '@pertexo/contracts';
import { isApiError } from '@/lib/api/error';
import { describeCommandError } from '@/lib/api/error-copy';
import { putMcpExposure, type McpSettingsScope } from './mcp-exposure.api';
import { mcpExposureKey } from './mcp-exposure.queries';

export function useMcpExposureCommand(scope: McpSettingsScope) {
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: WorkflowMcpExposureRequest) =>
      putMcpExposure(scope, body),
    onSettled: () =>
      cache.invalidateQueries({ queryKey: mcpExposureKey(scope) }),
  });
  return {
    pending: mutation.isPending,
    failure: mutation.isError ? exposureFailure(mutation.error) : undefined,
    send: async (body: WorkflowMcpExposureRequest) => {
      try {
        await mutation.mutateAsync(body);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function exposureFailure(error: unknown) {
  if (
    isApiError(error) &&
    error.problem?.code === 'workspace.conflict' &&
    error.problem.detail !== undefined
  )
    return error.problem.detail;
  return describeCommandError(error, 'updating MCP exposure');
}
