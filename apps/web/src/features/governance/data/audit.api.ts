import {
  auditPageSchema,
  governanceSettingsSchema,
  type AuditFilter,
  type GovernanceSettings,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type GovernanceScope = WorkspaceApiScope;
function base(scope: GovernanceScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/governance`;
}
export function readAudit(
  scope: GovernanceScope,
  filters: AuditFilter,
  after: string | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams([
    ['limit', '50'],
    ...Object.entries(filters).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ]);
  if (after !== null) query.set('after', after);
  return scope.apiClient.request({
    path: `${base(scope)}/audit?${query}`,
    signal,
    response: { kind: 'json', decode: (value) => auditPageSchema.parse(value) },
  });
}
export function readSettings(scope: GovernanceScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: `${base(scope)}/settings`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => governanceSettingsSchema.parse(value),
    },
  });
}
export function saveSettings(
  scope: GovernanceScope,
  body: { expectedRevision: number; auditRetentionDays: number },
  key: string,
): Promise<GovernanceSettings> {
  return scope.apiClient.request({
    path: `${base(scope)}/settings`,
    method: 'PUT',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => governanceSettingsSchema.parse(value),
    },
  });
}
export function exportAudit(
  scope: GovernanceScope,
  filters: AuditFilter,
): void {
  scope.apiClient.download({
    path: `${base(scope)}/audit/export`,
    body: filters,
  });
}
