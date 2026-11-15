import {
  authProviders,
  authProviderChecks,
  authSessions,
  authAccounts,
} from '@pertexo/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  providerRecords,
  type ProviderRow,
} from './identity-organizations.repository.js';
import type { PoolClient } from 'pg';
import type {
  CreateProviderInput,
  UpdateProviderInput,
} from './federation-management.types.js';

export async function lockOrganizationProvider(
  client: PoolClient,
  organizationId: string,
  providerId: string,
): Promise<ProviderRow | undefined> {
  const [provider] = await providerRecords(client)
    .where(
      and(
        eq(authProviders.organizationId, organizationId),
        eq(authProviders.id, providerId),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return provider;
}

export async function insertProvider(
  client: PoolClient,
  input: CreateProviderInput,
  {
    providerId,
    organizationId,
  }: Readonly<{ providerId: string; organizationId: string }>,
): Promise<void> {
  await drizzle(client)
    .insert(authProviders)
    .values({
      id: providerId,
      organizationId: organizationId,
      kind: input.kind ?? 'oidc',
      name: input.name,
      issuer: input.issuer,
      configuration: input.configuration,
      sealedSecret: input.kind === 'saml' ? null : input.sealSecret(providerId),
      enabled: input.enabled,
    })
    .catch(rethrowQueryFailure);
}

/** Saves the provider's settings; its tests and the sessions it signed in end. */
export async function updateProviderSettings(
  client: PoolClient,
  input: UpdateProviderInput,
  providerId: string,
): Promise<void> {
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
    .where(eq(authProviders.id, providerId))
    .catch(rethrowQueryFailure);
  await drizzle(client)
    .delete(authProviderChecks)
    .where(eq(authProviderChecks.providerId, providerId))
    .catch(rethrowQueryFailure);
  await drizzle(client)
    .delete(authSessions)
    .where(eq(authSessions.federationProviderId, providerId))
    .catch(rethrowQueryFailure);
}

/** Removes the provider and the accounts it linked. */
export async function deleteProvider(
  client: PoolClient,
  providerId: string,
): Promise<void> {
  await drizzle(client)
    .delete(authProviders)
    .where(eq(authProviders.id, providerId))
    .catch(rethrowQueryFailure);
  await drizzle(client)
    .delete(authAccounts)
    .where(eq(authAccounts.providerId, providerId))
    .catch(rethrowQueryFailure);
}
