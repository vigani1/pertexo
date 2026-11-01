import {
  authProviders,
  authProviderChecks,
  authSessions,
  authAccounts,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { providerRecords } from './records.queries.js';
import type { Pool, PoolClient } from 'pg';
import type {
  FederationSettings,
  OidcConfiguration,
  SamlConfiguration,
} from '@pertexo/contracts';
import { generatePersistedId } from '@pertexo/database/platform';
import { FederationConflictError } from './errors.js';
import type { ProviderRow } from './records.queries.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
} from './commands.repository.js';
import type { FederationCommand } from './contract.js';
import { requireResourceCapacity } from './organizations.repository.js';
import { assertRequiredDomainsReady } from './enforcement.repository.js';

type SealedSecret = Readonly<Record<string, unknown>>;
type ProviderValues = Readonly<{ name: string; enabled: boolean }> &
  (
    | Readonly<{ kind?: 'oidc'; configuration: OidcConfiguration }>
    | Readonly<{ kind: 'saml'; configuration: SamlConfiguration }>
  );
async function requireOrganizationProvider(
  client: PoolClient,
  organizationId: string,
  providerId: string,
): Promise<ProviderRow> {
  const [provider] = await providerRecords(client)
    .where(
      and(
        eq(authProviders.organizationId, organizationId),
        eq(authProviders.id, providerId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  if (provider === undefined)
    throw new FederationConflictError(
      'unavailable',
      'That sign-in provider is unavailable.',
    );
  return provider;
}
/** The API seals the secret and computes a purpose-bound HMAC for exact retries. Neither plaintext nor an unkeyed secret digest crosses this boundary. */
export function createProvider(
  pool: Pool,
  input: FederationCommand &
    Readonly<{ issuer: string }> &
    (
      | Readonly<{
          kind?: 'oidc';
          name: string;
          enabled: boolean;
          configuration: OidcConfiguration;
          sealSecret: (providerId: string) => SealedSecret;
          secretFingerprint: string;
        }>
      | Readonly<{
          kind: 'saml';
          name: string;
          enabled: boolean;
          configuration: SamlConfiguration;
        }>
    ),
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
      await drizzle(client)
        .insert(authProviders)
        .values({
          id: providerId,
          organizationId: organization.id,
          kind: input.kind ?? 'oidc',
          name: input.name,
          issuer: input.issuer,
          configuration: input.configuration,
          sealedSecret:
            input.kind === 'saml' ? null : input.sealSecret(providerId),
          enabled: input.enabled,
        })
        .catch(rethrowQueryFailure);
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
  input: FederationCommand &
    ProviderValues &
    Readonly<{
      providerId: string;
      sealedSecret?: SealedSecret;
      secretFingerprint?: string;
    }>,
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
      await drizzle(client)
        .update(authProviders)
        .set({
          name: input.name,
          configuration: input.configuration,
          sealedSecret:
            input.sealedSecret === undefined
              ? authProviders.sealedSecret
              : sql`coalesce(${sql.param(input.sealedSecret, authProviders.sealedSecret)},${authProviders.sealedSecret})`,
          enabled: input.enabled,
          revision: sql`${authProviders.revision}+1`,
        })
        .where(eq(authProviders.id, provider.id))
        .catch(rethrowQueryFailure);
      await drizzle(client)
        .delete(authProviderChecks)
        .where(eq(authProviderChecks.providerId, provider.id))
        .catch(rethrowQueryFailure);
      await drizzle(client)
        .delete(authSessions)
        .where(eq(authSessions.federationProviderId, provider.id))
        .catch(rethrowQueryFailure);
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
  input: FederationCommand & Readonly<{ providerId: string }>,
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
      await drizzle(client)
        .delete(authProviders)
        .where(eq(authProviders.id, provider.id))
        .catch(rethrowQueryFailure);
      await drizzle(client)
        .delete(authAccounts)
        .where(eq(authAccounts.providerId, provider.id))
        .catch(rethrowQueryFailure);
      await recordFederationAudit(client, input, {
        action: 'identity.provider_removed',
        targetId: organization.id,
        metadata: { providerId: provider.id },
      });
      return advanceOrganization(client, organization);
    },
  });
}
