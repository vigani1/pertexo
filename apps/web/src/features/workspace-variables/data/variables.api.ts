import {
  workspaceVariablesResponseSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  type WorkspaceVariablesRequest,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
function path(scope: WorkspaceApiScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/variables`;
}
export function readVariables(scope: WorkspaceApiScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: path(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => workspaceVariablesResponseSchema.parse(value),
    },
  });
}
export function replaceVariables(
  scope: WorkspaceApiScope,
  body: WorkspaceVariablesRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: path(scope),
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => workspaceVariablesCommandResponseSchema.parse(value),
    },
  });
}
export function readVariableUsage(
  scope: WorkspaceApiScope,
  name: string,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ name, limit: '25' });
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: `${path(scope)}/usage?${query}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => workspaceVariableUsageResponseSchema.parse(value),
    },
  });
}
