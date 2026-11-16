import {
  authOrganizationWorkspaces,
  authOrganizations,
} from '@pertexo/database/schema';

import { eq, getTableName } from 'drizzle-orm';

import { alias } from 'drizzle-orm/pg-core';

import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';

import { appendAuditFact } from '../../../governance/audit/facts.js';

import { organizationRecords } from './identity-organizations.repository.js';

import type { PoolClient } from 'pg';

import type { FederationScope } from './federation-management.types.js';

import type { OrganizationRow } from './identity-organizations.repository.js';

export async function organizationForWorkspace(
  client: PoolClient,
  workspaceId: string,
  { locking = false }: Readonly<{ locking?: boolean | undefined }> = {},
): Promise<OrganizationRow | undefined> {
  const query = organizationRecords(client)
    .innerJoin(
      authOrganizationWorkspaces,
      eq(authOrganizationWorkspaces.organizationId, authOrganizations.id),
    )
    .where(eq(authOrganizationWorkspaces.workspaceId, workspaceId));
  const [row] = await (
    locking ? query.for('update', { of: organizationLockTarget }) : query
  ).catch(rethrowQueryFailure);
  return row;
}
export async function recordFederationAudit(
  client: PoolClient,
  scope: FederationScope,
  {
    action,
    targetId,
    metadata = {},
  }: Readonly<{
    action: string;
    targetId: string;
    metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
  }>,
): Promise<void> {
  await withWorkspaceScope(client, scope, (scoped) =>
    appendAuditFact(scoped, {
      workspaceId: scope.workspaceId,
      actorId: scope.actorId,
      action,
      targetType: 'identity_organization',
      targetId,
      metadata,
    }),
  );
}

const organizationLockTarget = alias(
  authOrganizations,
  getTableName(authOrganizations),
);
