import type { Pool, PoolClient } from 'pg';
import type { FederationSettings, OidcConfiguration } from '@pertexo/contracts';
import { generatePersistedId } from '../../../platform/persisted-id.js';
import { FederationConflictError, type ProviderRow } from './contract.js';
import { recordFederationAudit } from './authority.js';
import {
  advanceOrganization,
  assertOrganizationRevision,
  requireControlOrganization,
  runFederationCommand,
  type FederationCommand,
} from './commands.js';
import { requireResourceCapacity } from './organizations.js';
import { assertRequiredDomainsReady } from './enforcement.js';

type SealedSecret = Readonly<Record<string, unknown>>;
type ProviderValues = Readonly<{
  name: string;
  configuration: OidcConfiguration;
  enabled: boolean;
}>;
async function requireOrganizationProvider(
  client: PoolClient,
  organizationId: string,
  providerId: string,
): Promise<ProviderRow> {
  const provider = (
    await client.query<ProviderRow>(
      "select * from app.auth_providers where organization_id=$1 and id=$2 and kind='oidc' for update",
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
export function createOidcProvider(
  pool: Pool,
  input: FederationCommand &
    ProviderValues &
    Readonly<{
      issuer: string;
      sealSecret: (providerId: string) => SealedSecret;
      secretFingerprint: string;
    }>,
): Promise<FederationSettings> {
  return runFederationCommand(
    pool,
    input,
    'identity.provider.create',
    {
      name: input.name,
      issuer: input.issuer,
      configuration: input.configuration,
      enabled: input.enabled,
      secretFingerprint: input.secretFingerprint,
      expectedRevision: input.expectedRevision,
    },
    async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      await requireResourceCapacity(client, organization.id, 'providers');
      const providerId = generatePersistedId();
      await client.query(
        "insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration,sealed_secret,enabled) values($1,$2,'oidc',$3,$4,$5::jsonb,$6::jsonb,$7)",
        [
          providerId,
          organization.id,
          input.name,
          input.issuer,
          JSON.stringify(input.configuration),
          JSON.stringify(input.sealSecret(providerId)),
          input.enabled,
        ],
      );
      await recordFederationAudit(
        client,
        input,
        'identity.provider_created',
        organization.id,
        { providerId: providerId, kind: 'oidc', enabled: input.enabled },
      );
      return advanceOrganization(client, organization);
    },
  );
}
export function updateOidcProvider(
  pool: Pool,
  input: FederationCommand &
    ProviderValues &
    Readonly<{
      providerId: string;
      sealedSecret?: SealedSecret;
      secretFingerprint?: string;
    }>,
): Promise<FederationSettings> {
  return runFederationCommand(
    pool,
    input,
    'identity.provider.update',
    {
      providerId: input.providerId,
      name: input.name,
      configuration: input.configuration,
      enabled: input.enabled,
      secretFingerprint: input.secretFingerprint ?? null,
      expectedRevision: input.expectedRevision,
    },
    async (client) => {
      const organization = await requireControlOrganization(client, input);
      assertOrganizationRevision(organization, input.expectedRevision);
      const provider = await requireOrganizationProvider(
        client,
        organization.id,
        input.providerId,
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
      await recordFederationAudit(
        client,
        input,
        'identity.provider_changed',
        organization.id,
        {
          providerId: provider.id,
          enabled: input.enabled,
          secretChanged: input.sealedSecret !== undefined,
        },
      );
      return advanceOrganization(client, organization);
    },
  );
}
export function removeOidcProvider(
  pool: Pool,
  input: FederationCommand & Readonly<{ providerId: string }>,
): Promise<FederationSettings> {
  return runFederationCommand(
    pool,
    input,
    'identity.provider.remove',
    { providerId: input.providerId, expectedRevision: input.expectedRevision },
    async (client) => {
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
      await recordFederationAudit(
        client,
        input,
        'identity.provider_removed',
        organization.id,
        { providerId: provider.id },
      );
      return advanceOrganization(client, organization);
    },
  );
}
