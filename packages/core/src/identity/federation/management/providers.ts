import type { Pool, PoolClient } from 'pg';

import type { FederationSettings } from '@pertexo/contracts';

import { generatePersistedId } from '@pertexo/database/platform';

import { FederationConflictError } from './federation-management.errors.js';

import type { ProviderRow } from './identity-organizations.repository.js';

import { recordFederationAudit } from './authority.repository.js';

import { advanceOrganization } from './commands.repository.js';

import {
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './federation-authority.js';

import type {
  CreateProviderInput,
  RemoveProviderInput,
  UpdateProviderInput,
} from './federation-management.types.js';

import { requireResourceCapacity } from './organizations.js';

import { assertRequiredDomainsReady } from './enforcement.js';

import {
  deleteProvider,
  insertProvider,
  lockOrganizationProvider,
  updateProviderSettings,
} from './providers.repository.js';

async function requireOrganizationProvider(
  client: PoolClient,
  organizationId: string,
  providerId: string,
): Promise<ProviderRow> {
  const provider = await lockOrganizationProvider(
    client,
    organizationId,
    providerId,
  );
  if (provider === undefined)
    throw new FederationConflictError(
      'unavailable',
      'That sign-in provider is unavailable.',
    );
  return provider;
}
export function createProvider(
  pool: Pool,
  input: CreateProviderInput,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.provider.create',
    request: {
      name: input.name,
      issuer: input.issuer,
      configuration: input.configuration,
      enabled: input.enabled,
      secretFingerprint: input.kind === 'saml' ? null : input.secretFingerprint,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      await requireResourceCapacity(client, organization.id, 'providers');
      const providerId = generatePersistedId();
      await insertProvider(client, input, {
        providerId,
        organizationId: organization.id,
      });
      await recordFederationAudit(client, input, {
        action: 'identity.provider_created',
        targetId: organization.id,
        metadata: {
          providerId,
          kind: input.kind ?? 'oidc',
          enabled: input.enabled,
        },
      });
      return advanceOrganization(client, organization);
    },
  });
}
export function updateProvider(
  pool: Pool,
  input: UpdateProviderInput,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.provider.update',
    request: {
      providerId: input.providerId,
      name: input.name,
      configuration: input.configuration,
      enabled: input.enabled,
      secretFingerprint: input.secretFingerprint ?? null,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const provider = await requireOrganizationProvider(
        client,
        organization.id,
        input.providerId,
      );
      if (provider.kind !== (input.kind ?? 'oidc'))
        throw new FederationConflictError(
          'unavailable',
          'That sign-in provider has a different protocol.',
        );
      await assertRequiredDomainsReady(client, organization.id, provider.id);
      await updateProviderSettings(client, input, provider.id);
      await recordFederationAudit(client, input, {
        action: 'identity.provider_changed',
        targetId: organization.id,
        metadata: {
          providerId: provider.id,
          enabled: input.enabled,
          secretChanged: input.sealedSecret !== undefined,
        },
      });
      return advanceOrganization(client, organization);
    },
  });
}
export function removeProvider(
  pool: Pool,
  input: RemoveProviderInput,
): Promise<FederationSettings> {
  return runFederationCommand(pool, input, {
    operation: 'identity.provider.remove',
    request: {
      providerId: input.providerId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const provider = await requireOrganizationProvider(
        client,
        organization.id,
        input.providerId,
      );
      await assertRequiredDomainsReady(client, organization.id, provider.id);
      await deleteProvider(client, provider.id);
      await recordFederationAudit(client, input, {
        action: 'identity.provider_removed',
        targetId: organization.id,
        metadata: { providerId: provider.id },
      });
      return advanceOrganization(client, organization);
    },
  });
}
