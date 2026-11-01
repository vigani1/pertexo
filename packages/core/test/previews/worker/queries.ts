import { withTenantScopedClient } from '@pertexo/database/primitives';

import { workspaceId, apiPool, workerPool } from './base.js';

// Post-state assertions must observe rows through a tenant-scoped serving
// client: forced RLS hides everything from context-free connections.
export function scopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(workerPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

export function apiScopedQuery<T extends Record<string, unknown>>(
  sqlText: string,
  params: unknown[] = [],
) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<T>(sqlText, params),
  );
}

export async function previewTerminalFacts(previewRunId: string) {
  const [audit, usage] = await Promise.all([
    apiScopedQuery<{
      actor_user_id: string;
      id: string;
      metadata: Record<string, unknown>;
      request_id: string | null;
      trace_id: string | null;
    }>(
      `select id,actor_user_id,request_id,trace_id,metadata
         from app.audit_events
        where workspace_id=$1 and action='preview.execution_terminal'
          and target_type='preview-run' and target_id=$2`,
      [workspaceId, previewRunId],
    ),
    apiScopedQuery<{
      category: string;
      id: string;
      idempotency_key: string;
      metadata: Record<string, unknown>;
      quantity: string;
    }>(
      `select id,category,quantity::text,idempotency_key,metadata
         from app.usage_events
        where workspace_id=$1 and resource_type='preview-run'
          and resource_id=$2`,
      [workspaceId, previewRunId],
    ),
  ]);
  return { audit: audit.rows, usage: usage.rows } as const;
}
