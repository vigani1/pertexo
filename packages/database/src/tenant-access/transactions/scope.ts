import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import type { PoolClient } from 'pg';

import { workspaceIdSchema } from './input.js';
import type { WorkspaceId, TransactionScope } from './contract.js';

export function parseWorkspaceId(value: string): WorkspaceId {
  return workspaceIdSchema.parse(value) as WorkspaceId;
}

export async function installTransactionScope(
  client: PoolClient,
  scope: TransactionScope | undefined,
): Promise<void> {
  if (scope === undefined) {
    // Platform-global transactions deliberately install no tenant context.
    return;
  }
  if (scope.workspaceId === undefined) {
    await client.query(
      `select set_config('app.actor_id', $1, true),
              set_config('app.discovery_scope', $2, true)`,
      [scope.actorId, scope.discoveryScope],
    );
    return;
  }
  if (scope.actorId === undefined) {
    await client.query("select set_config('app.workspace_id', $1, true)", [
      scope.workspaceId,
    ]);
    return;
  }
  await client.query(
    "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
    [scope.workspaceId, scope.actorId],
  );
}

export async function assertNoTenantContext(client: PoolClient): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
    discovery_scope: string | null;
  }>(
    `select current_setting('app.workspace_id', true) as workspace_id,
            current_setting('app.actor_id', true) as actor_id,
            current_setting('app.discovery_scope', true) as discovery_scope`,
  );
  const row = result.rows[0];
  const hasWorkspaceContext =
    row?.workspace_id !== undefined &&
    row.workspace_id !== null &&
    row.workspace_id !== '';
  if (hasWorkspaceContext) {
    throw new Error('Pooled PostgreSQL client retained workspace context');
  }
  const hasActorContext =
    row?.actor_id !== undefined && row.actor_id !== null && row.actor_id !== '';
  if (hasActorContext) {
    throw new Error('Pooled PostgreSQL client retained actor context');
  }
  const hasDiscoveryContext =
    row?.discovery_scope !== undefined &&
    row.discovery_scope !== null &&
    row.discovery_scope !== '';
  if (hasDiscoveryContext) {
    throw new Error('Pooled PostgreSQL client retained discovery context');
  }
}

export async function verifyTenantContext(
  client: PoolClient,
  scope: TransactionScope,
  statementTimeoutMillis: number | undefined,
): Promise<void> {
  const result = await client.query<{
    workspace_id: string | null;
    actor_id: string | null;
    discovery_scope?: string | null;
    statement_timeout_millis: string | number;
  }>(
    `select current_setting('app.workspace_id', true) as workspace_id,
            current_setting('app.actor_id', true) as actor_id,
            current_setting('app.discovery_scope', true) as discovery_scope,
            (select setting::bigint from pg_settings where name='statement_timeout')
              as statement_timeout_millis`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  const expectedWorkspaceId = scope.workspaceId ?? null;
  const actualWorkspaceId = row.workspace_id === '' ? null : row.workspace_id;
  if (actualWorkspaceId !== expectedWorkspaceId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  if (scope.actorId !== undefined && row.actor_id !== scope.actorId) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  const expectedDiscoveryScope =
    'discoveryScope' in scope ? scope.discoveryScope : null;
  const actualDiscoveryScope =
    row.discovery_scope === undefined || row.discovery_scope === ''
      ? null
      : row.discovery_scope;
  if (actualDiscoveryScope !== expectedDiscoveryScope) {
    throw new Error('PostgreSQL tenant context verification failed');
  }
  if (
    statementTimeoutMillis !== undefined &&
    Number(row.statement_timeout_millis) !== statementTimeoutMillis
  ) {
    throw new Error('PostgreSQL transaction timeout verification failed');
  }
}

export function parseStatementTimeout(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const invalidTimeout = !isIntegerInRange(value, 1, 2_147_483_647);
  if (invalidTimeout) {
    throw new RangeError('Invalid PostgreSQL statement timeout');
  }
  return value;
}
