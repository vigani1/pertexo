import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import {
  appendAuditFact,
  withTenantScopedClient,
  withTenantScopedReadClient,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';

import type { Pool, PoolClient } from 'pg';

import {
  lockWorkspaceAuthority,
  readWorkspaceAuthority,
} from '../../shared/authority.queries.js';
import { rolesForCapability } from '@pertexo/workflow-model';

import type { DataTableScope } from '../contract.js';

import { translateTableConstraint } from '../rows.repository.js';

export function read<T>(
  pool: Pool,
  scope: DataTableScope,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedReadClient(
    pool,
    scope,
    async (client) => {
      await readWorkspaceAuthority(client, scope.workspaceId, {
        actorId: scope.actorId,
        roles: rolesForCapability('workspace:read'),
        allowedStatuses: ['active', 'suspended', 'pending_deletion'],
      });
      return work(client);
    },
    scope.signal === undefined ? {} : { signal: scope.signal },
  );
}

export function write<T>(
  pool: Pool,
  scope: DataTableScope,
  work: (client: PoolClient) => Promise<T>,
  { admin = false }: Readonly<{ admin?: boolean | undefined }> = {},
) {
  return withTenantScopedClient(
    pool,
    scope,
    async (client) => {
      await lockWorkspaceAuthority(
        client,
        scope.workspaceId,
        scope.actorId,
        admin ? ADMINISTRATIVE_ROLES : rolesForCapability('workflow:update'),
      );
      return work(client);
    },
    scope.signal === undefined ? {} : { signal: scope.signal },
  ).catch(translateTableConstraint);
}

export async function command<T extends object>(
  client: PoolClient,
  input: DataTableScope & { idempotencyKey: string },
  {
    operation,
    audit,
    request,
    work,
  }: Readonly<{
    operation: string;
    audit:
      | ((result: T) => Readonly<{
          targetId: string;
          targetType: 'workspace' | 'data_table';
          metadata?: Readonly<Record<string, unknown>>;
        }>)
      | null;
    request: unknown;
    work: () => Promise<T>;
  }>,
): Promise<T> {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation,
    idempotencyKey: input.idempotencyKey,
  };
  const prior = await claimCommand(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex'),
  });
  if (prior !== null) return prior as T;
  const result = await work();
  if (audit !== null)
    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: operation,
      ...audit(result),
    });
  await completeCommand(client, identity, result);
  return result;
}
