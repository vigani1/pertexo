import type { PoolClient, QueryResult } from 'pg';
import { findCommandResult } from '../../../platform/idempotency.js';
import { federationSettingsSchema } from '@pertexo/contracts';
import type { FederationCommand } from './commands.js';
import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import {
  withPlatformTransaction,
  withWorkspaceScope,
} from '../../../tenant-access/transactions.js';
import { readWorkspaceAuthority } from '../../../tenant-access/workspaces/authority.js';
import { FederationConflictError, type FederationScope } from './contract.js';
import { organizationForWorkspace } from './authority.js';
import { projectOrganization } from './settings.js';
import {
  createOrganization,
  linkOrganizationWorkspace,
} from './organizations.js';
import {
  createDomain,
  renewDomainChallenge,
  verifyDomain,
  removeDomain,
} from './domains.js';
import { createProvider, updateProvider, removeProvider } from './providers.js';
import { configureDomainEnforcement } from './enforcement.js';
import type { FederationSettings } from '@pertexo/contracts';

interface StoredProviderSecret {
  id: string;
  sealed_secret: unknown;
  control_workspace_id: string;
}
export function createFederationManagementStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const read = <T>(
    scope: FederationScope,
    ownerOnly: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ) =>
    withPlatformTransaction(
      lease.pool,
      async (client) => {
        const role = await withWorkspaceScope(client, scope, (scoped) =>
          readWorkspaceAuthority(scoped, scope.workspaceId, scope.actorId, [
            'owner',
            'admin',
          ]),
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
  return {
    close: () => lease.close(),
    settings: (scope: FederationScope): Promise<FederationSettings> =>
      read(scope, false, async (client) => {
        const organization = await organizationForWorkspace(
          client,
          scope.workspaceId,
        );
        const isOwner = await withWorkspaceScope(
          client,
          scope,
          async (scoped) =>
            (
              await scoped.query(
                "select 1 from app.workspace_memberships where workspace_id=$1 and user_id=$2 and role='owner' and status='active'",
                [scope.workspaceId, scope.actorId],
              )
            ).rowCount === 1,
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
      }),
    domainChallenge: (
      scope: FederationScope & Readonly<{ domainId: string }>,
    ) =>
      read(scope, true, async (client) => {
        const organization = await organizationForWorkspace(
          client,
          scope.workspaceId,
        );
        if (organization?.control_workspace_id !== scope.workspaceId)
          throw new FederationConflictError(
            'owner_required',
            'Manage domains from the control workspace.',
          );
        const row = (
          await client.query<{ domain: string; challenge: string | null }>(
            'select domain,challenge from app.auth_domains where id=$1 and organization_id=$2 and verified_at is null and challenge_expires_at>clock_timestamp()',
            [scope.domainId, organization.id],
          )
        ).rows[0];
        if (row?.challenge === null || row === undefined)
          throw new FederationConflictError(
            'dns_unverified',
            'The DNS challenge is unavailable or expired.',
          );
        return { domain: row.domain, challenge: row.challenge };
      }),
    checkStoredSecrets: async (
      check: (sealed: unknown, workspaceId: string, providerId: string) => void,
    ): Promise<void> => {
      let after: string | null = null;
      for (;;) {
        const batch: QueryResult<StoredProviderSecret> =
          await lease.pool.query<StoredProviderSecret>(
            `select provider.id,provider.sealed_secret,organization.control_workspace_id from app.auth_providers provider join app.auth_organizations organization on organization.id=provider.organization_id where provider.sealed_secret is not null and ($1::uuid is null or provider.id>$1) order by provider.id limit 100`,
            [after],
          );
        for (const row of batch.rows)
          check(row.sealed_secret, row.control_workspace_id, row.id);
        const last: StoredProviderSecret | undefined = batch.rows.at(-1);
        if (batch.rows.length < 100 || last === undefined) return;
        after = last.id;
      }
    },
    verificationResult: (
      input: FederationCommand & Readonly<{ domainId: string }>,
    ) =>
      read(input, true, async (client) => {
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
          findCommandResult(scoped, {
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
        return stored === null ? null : federationSettingsSchema.parse(stored);
      }),
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
