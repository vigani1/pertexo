import { durationSettingMillisSql } from '../../platform/duration-setting.js';
import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import type { PoolClient } from 'pg';

import { scopeIdSchema } from './input.js';
import type {
  WorkspaceId,
  TransactionScope,
} from './workspace-transaction.types.js';

export function parseWorkspaceId(value: string): WorkspaceId {
  return scopeIdSchema.parse(value) as WorkspaceId;
}

/** Organization authority spans per-workspace projections but ends with this transaction. */
export async function setOrganizationContext(
  client: PoolClient,
  organizationId: string | undefined,
): Promise<void> {
  const value =
    organizationId === undefined ? '' : scopeIdSchema.parse(organizationId);
  const result = await client.query<{ organization_id: string }>(
    "select set_config('app.organization_id',$1,true) organization_id",
    [value],
  );
  if (result.rows[0]?.organization_id !== value)
    throw new Error('PostgreSQL organization context verification failed');
}

/**
 * Switches the scope inside an open transaction, changing only the settings
 * the scope names (an actor stays installed when a flow moves to another of
 * its workspaces).
 */
export async function installTransactionScope(
  client: PoolClient,
  scope: TransactionScope | undefined,
): Promise<void> {
  // Platform-global transactions deliberately install no tenant context.
  if (scope === undefined) return;
  await applyContext(client, {
    workspaceId:
      scope.workspaceId === undefined
        ? undefined
        : parseWorkspaceId(scope.workspaceId),
    actorId: scope.actorId,
    discoveryScope:
      'discoveryScope' in scope ? scope.discoveryScope : undefined,
  });
}

/**
 * Sets a transaction's whole context in one statement: every tenant setting,
 * organization included (empty when the scope lacks it), and the statement
 * timeout. The context is then exactly what the statement returned. All of
 * them are transaction-local, so the next user of a pooled client starts
 * without them; the transaction-local-settings check keeps session-level ones
 * out of the code.
 */
export async function installTransactionContext(
  client: PoolClient,
  scope: TransactionScope | undefined,
  statementTimeoutMillis: number | undefined,
): Promise<void> {
  await applyContext(client, {
    ...(scope === undefined
      ? {}
      : { ...completeScope(scope), organizationId: '' }),
    statementTimeoutMillis,
  });
}

/** Opens a nested scope; organization context belongs to the outer transaction. */
export async function installNestedScope(
  client: PoolClient,
  scope: TransactionScope,
): Promise<void> {
  await applyContext(client, completeScope(scope));
}

/** Ends a nested scope; organization context belongs to the outer transaction. */
export async function clearNestedScope(client: PoolClient): Promise<void> {
  await applyContext(client, {
    workspaceId: '',
    actorId: '',
    discoveryScope: '',
  });
}

/** Refuses to nest one scope inside another within a transaction. */
export async function assertNoNestedScope(client: PoolClient): Promise<void> {
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
  if (isSet(row?.workspace_id))
    throw new Error('PostgreSQL transaction retained workspace context');
  if (isSet(row?.actor_id))
    throw new Error('PostgreSQL transaction retained actor context');
  if (isSet(row?.discovery_scope))
    throw new Error('PostgreSQL transaction retained discovery context');
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

/** An absent setting is left as it is. */
type ContextSettings = Readonly<{
  workspaceId?: string | undefined;
  actorId?: string | undefined;
  discoveryScope?: string | undefined;
  organizationId?: string | undefined;
  statementTimeoutMillis?: number | undefined;
}>;

const TENANT_SETTINGS = [
  ['workspaceId', 'app.workspace_id'],
  ['actorId', 'app.actor_id'],
  ['discoveryScope', 'app.discovery_scope'],
  ['organizationId', 'app.organization_id'],
] as const;

function completeScope(scope: TransactionScope): ContextSettings {
  return {
    workspaceId:
      scope.workspaceId === undefined
        ? ''
        : parseWorkspaceId(scope.workspaceId),
    actorId: scope.actorId ?? '',
    discoveryScope: 'discoveryScope' in scope ? scope.discoveryScope : '',
  };
}

/**
 * Sets the given settings in one statement and checks the values PostgreSQL
 * returns, so a scope is never trusted before it is confirmed.
 */
async function applyContext(
  client: PoolClient,
  settings: ContextSettings,
): Promise<void> {
  const columns: string[] = [];
  const values: string[] = [];
  for (const [key, name] of TENANT_SETTINGS) {
    const value = settings[key];
    if (value === undefined) continue;
    values.push(value);
    columns.push(
      `set_config('${name}',$${String(values.length)},true) "${key}"`,
    );
  }
  const timeout = settings.statementTimeoutMillis;
  if (timeout !== undefined) {
    values.push(`${String(timeout)}ms`);
    const timeoutSet = `set_config('statement_timeout',$${String(values.length)},true)`;
    columns.push(
      `${durationSettingMillisSql(timeoutSet)} "statementTimeoutMillis"`,
    );
  }
  if (columns.length === 0) return;
  const result = await client.query<
    Record<(typeof TENANT_SETTINGS)[number][0], string> & {
      statementTimeoutMillis: string;
    }
  >(`select ${columns.join(',')}`, values);
  const row = result.rows[0];
  if (row === undefined)
    throw new Error('PostgreSQL tenant context verification failed');
  for (const [key] of TENANT_SETTINGS) {
    const expected = settings[key];
    if (expected !== undefined && row[key] !== expected)
      throw new Error('PostgreSQL tenant context verification failed');
  }
  if (timeout !== undefined && Number(row.statementTimeoutMillis) !== timeout)
    throw new Error('PostgreSQL transaction timeout verification failed');
}

function isSet(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value !== '';
}
