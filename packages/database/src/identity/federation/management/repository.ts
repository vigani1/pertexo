import { workspaceMemberships } from '../../../schema/foundation.js';
import { authDomains } from '../../../schema/identity/federation/domains.js';
import { authProviders } from '../../../schema/identity/federation/providers.js';
import { authOrganizations } from '../../../schema/identity/federation/organizations.js';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { ADMINISTRATIVE_ROLES } from '@pertexo/workflow-model';
import type { Pool, PoolClient } from 'pg';
import { findCommandResult } from '../../../platform/idempotency/repository.js';

import type { FederationCommand } from './commands.repository.js';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../tenant-access/transactions.js';
import { readWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.queries.js';
import { FederationConflictError, type FederationScope } from './contract.js';
import { organizationForWorkspace } from './authority.repository.js';
import { projectOrganization } from './settings.queries.js';
import {
  createOrganization,
  linkOrganizationWorkspace,
} from './organizations.repository.js';
import {
  createDomain,
  renewDomainChallenge,
  verifyDomain,
  removeDomain,
} from './domains.repository.js';
import {
  createProvider,
  updateProvider,
  removeProvider,
} from './providers.repository.js';
import { configureDomainEnforcement } from './enforcement.repository.js';
import type { FederationSettings } from '@pertexo/contracts';

export function createFederationManagementStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);

  return {
    close: () => lease.close(),
    settings: (scope: FederationScope) =>
      readFederationSettings(lease.pool, scope),
    domainChallenge: (
      scope: FederationScope & Readonly<{ domainId: string }>,
    ) => readDomainChallenge(lease.pool, scope),
    checkStoredSecrets: (
      check: (sealed: unknown, workspaceId: string, providerId: string) => void,
    ) => checkFederationStoredSecrets(lease.pool, check),
    verificationResult: (
      input: FederationCommand & Readonly<{ domainId: string }>,
    ) => readDomainVerificationResult(lease.pool, input),
    createOrganization: (input: Parameters<typeof createOrganization>[1]) =>
      createOrganization(lease.pool, input),
    linkWorkspace: (input: Parameters<typeof linkOrganizationWorkspace>[1]) =>
      linkOrganizationWorkspace(lease.pool, input),
    createDomain: (input: Parameters<typeof createDomain>[1]) =>
      createDomain(lease.pool, input),
    renewDomainChallenge: (input: Parameters<typeof renewDomainChallenge>[1]) =>
      renewDomainChallenge(lease.pool, input),
    verifyDomain: (input: Parameters<typeof verifyDomain>[1]) =>
      verifyDomain(lease.pool, input),
    removeDomain: (input: Parameters<typeof removeDomain>[1]) =>
      removeDomain(lease.pool, input),
    createProvider: (input: Parameters<typeof createProvider>[1]) =>
      createProvider(lease.pool, input),
    updateProvider: (input: Parameters<typeof updateProvider>[1]) =>
      updateProvider(lease.pool, input),
    removeProvider: (input: Parameters<typeof removeProvider>[1]) =>
      removeProvider(lease.pool, input),
    configureEnforcement: (
      input: Parameters<typeof configureDomainEnforcement>[1],
    ) => configureDomainEnforcement(lease.pool, input),
  };
}
export type FederationManagementStore = ReturnType<
  typeof createFederationManagementStore
>;

function read<T>(
  pool: Pool,
  scope: FederationScope,
  {
    ownerOnly,
    operation,
  }: Readonly<{
    ownerOnly: boolean;
    operation: (client: PoolClient) => Promise<T>;
  }>,
) {
  return withPlatformTransaction(
    pool,
    async (client) => {
      const role = await withWorkspaceScope(client, scope, (scoped) =>
        readWorkspaceAuthority(scoped, scope.workspaceId, {
          actorId: scope.actorId,
          roles: ADMINISTRATIVE_ROLES,
        }),
      );
      if (ownerOnly && role !== 'owner')
        throw new FederationConflictError(
          'owner_required',
          'Only the control workspace owner can manage organization sign-in.',
        );
      return operation(client);
    },
    scope.signal === undefined ? {} : { signal: scope.signal },
  );
}
function readFederationSettings(
  pool: Pool,
  scope: FederationScope,
): Promise<FederationSettings> {
  return read(pool, scope, {
    ownerOnly: false,
    operation: async (client) => {
      const organization = await organizationForWorkspace(
        client,
        scope.workspaceId,
      );
      const isOwner = await withWorkspaceScope(
        client,
        scope,
        async (scoped) =>
          (
            await drizzle(scoped)
              .select({ one: sql`1` })
              .from(workspaceMemberships)
              .where(
                and(
                  eq(workspaceMemberships.workspaceId, scope.workspaceId),
                  eq(workspaceMemberships.userId, scope.actorId),
                  eq(workspaceMemberships.role, 'owner'),
                  eq(workspaceMemberships.status, 'active'),
                ),
              )
              .catch(rethrowQueryFailure)
          ).length === 1,
      );
      return {
        configured: true,
        reason: null,
        canManage:
          isOwner &&
          (organization === undefined ||
            organization.control_workspace_id === scope.workspaceId),
        organization:
          organization === undefined
            ? null
            : await projectOrganization(client, organization),
      };
    },
  });
}

function readDomainChallenge(
  pool: Pool,
  scope: FederationScope & Readonly<{ domainId: string }>,
) {
  return read(pool, scope, {
    ownerOnly: true,
    operation: async (client) => {
      const organization = await organizationForWorkspace(
        client,
        scope.workspaceId,
      );
      if (organization?.control_workspace_id !== scope.workspaceId)
        throw new FederationConflictError(
          'owner_required',
          'Manage domains from the control workspace.',
        );
      const [row] = await drizzle(client)
        .select({
          domain: authDomains.domain,
          challenge: authDomains.challenge,
        })
        .from(authDomains)
        .where(
          and(
            eq(authDomains.id, scope.domainId),
            eq(authDomains.organizationId, organization.id),
            isNull(authDomains.verifiedAt),
            gt(authDomains.challengeExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .catch(rethrowQueryFailure);
      if (row?.challenge === null || row === undefined)
        throw new FederationConflictError(
          'dns_unverified',
          'The DNS challenge is unavailable or expired.',
        );
      return { domain: row.domain, challenge: row.challenge };
    },
  });
}

async function checkFederationStoredSecrets(
  pool: Pool,
  check: (sealed: unknown, workspaceId: string, providerId: string) => void,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const batch = await storedProviderSecrets(pool, after);
    for (const row of batch)
      check(row.sealed_secret, row.control_workspace_id, row.id);
    const last = batch.at(-1);
    if (batch.length < 100 || last === undefined) return;
    after = last.id;
  }
}

function readDomainVerificationResult(
  pool: Pool,
  input: FederationCommand & Readonly<{ domainId: string }>,
) {
  return read(pool, input, {
    ownerOnly: true,
    operation: async (client) => {
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
      );
      if (organization?.control_workspace_id !== input.workspaceId)
        throw new FederationConflictError(
          'owner_required',
          'Manage domains from the control workspace.',
        );
      const stored = await withWorkspaceScope(client, input, (scoped) =>
        findCommandResult<FederationSettings>(scoped, {
          workspaceId: input.workspaceId,
          scope: input.actorId,
          operation: 'identity.domain.verify',
          idempotencyKey: input.idempotencyKey,
          request: {
            domainId: input.domainId,
            expectedRevision: input.expectedRevision,
          },
        }),
      );
      return stored;
    },
  });
}

function storedProviderSecrets(pool: Pool, after: string | null) {
  return drizzle(pool)
    .select({
      id: authProviders.id,
      sealed_secret: authProviders.sealedSecret,
      control_workspace_id: authOrganizations.controlWorkspaceId,
    })
    .from(authProviders)
    .innerJoin(
      authOrganizations,
      eq(authOrganizations.id, authProviders.organizationId),
    )
    .where(
      and(
        isNotNull(authProviders.sealedSecret),
        after === null ? undefined : gt(authProviders.id, after),
      ),
    )
    .orderBy(asc(authProviders.id))
    .limit(100)
    .catch(rethrowQueryFailure);
}
