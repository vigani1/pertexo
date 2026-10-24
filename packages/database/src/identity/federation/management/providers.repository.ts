import type { Pool, PoolClient } from 'pg';
import type {
  FederationSettings,
  OidcConfiguration,
  SamlConfiguration,
} from '@pertexo/contracts';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { FederationConflictError, type ProviderRow } from './contract.js';
import { recordFederationAudit } from './authority.repository.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
  type FederationCommand,
} from './commands.repository.js';
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
  const provider = (
    await client.query<ProviderRow>(
      'select * from app.auth_providers where organization_id=$1 and id=$2 for update',
      [organizationId, providerId],
    )
  ).rows[0];
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
      await client.query(
        'insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration,sealed_secret,enabled) values($1,$2,$8,$3,$4,$5::jsonb,$6::jsonb,$7)',
        [
          providerId,
          organization.id,
          input.name,
          input.issuer,
          JSON.stringify(input.configuration),
          input.kind === 'saml'
            ? null
            : JSON.stringify(input.sealSecret(providerId)),
          input.enabled,
          input.kind ?? 'oidc',
        ],
      );
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
      await client.query(
        'update app.auth_providers set name=$2,configuration=$3::jsonb,sealed_secret=coalesce($4::jsonb,sealed_secret),enabled=$5,revision=revision+1 where id=$1',
        [
          provider.id,
          input.name,
          JSON.stringify(input.configuration),
          input.sealedSecret === undefined
            ? null
            : JSON.stringify(input.sealedSecret),
          input.enabled,
        ],
      );
      await client.query(
        'delete from app.auth_provider_checks where provider_id=$1',
        [provider.id],
      );
      await client.query(
        'delete from app.auth_sessions where federation_provider_id=$1',
        [provider.id],
      );
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
      await client.query('delete from app.auth_providers where id=$1', [
        provider.id,
      ]);
      await client.query('delete from app.auth_accounts where provider_id=$1', [
        provider.id,
      ]);
      await recordFederationAudit(client, input, {
        action: 'identity.provider_removed',
        targetId: organization.id,
        metadata: { providerId: provider.id },
      });
      return advanceOrganization(client, organization);
    },
  });
}
