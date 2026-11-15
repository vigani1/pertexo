import { authProvisioningCredentials } from '@pertexo/database/schema';

import { and, count, eq, isNull, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  credentialRecords,
  credentialSelection,
} from './credential-records.repository.js';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import type { CreateCredentialInput } from '../directory-provisioning.types.js';

export async function countLiveCredentials(
  client: PoolClient,
  organizationId: string,
): Promise<number> {
  const [countRow] = await drizzle(client)
    .select({ count: count() })
    .from(authProvisioningCredentials)
    .where(
      and(
        eq(authProvisioningCredentials.organizationId, organizationId),
        isNull(authProvisioningCredentials.revokedAt),
      ),
    )
    .catch(rethrowQueryFailure);
  return countRow?.count ?? 0;
}

export async function insertCredential(
  client: PoolClient,
  input: CreateCredentialInput,
  {
    id,
    organizationId,
    secretDigest,
  }: Readonly<{ id: string; organizationId: string; secretDigest: string }>,
) {
  const [row] = await drizzle(client)
    .insert(authProvisioningCredentials)
    .values({
      id,
      organizationId: organizationId,
      name: input.name,
      secretDigest,
      createdBy: input.actorId,
    })
    .returning(credentialSelection)
    .catch(rethrowQueryFailure);
  if (row === undefined) throw new Error('Credential creation returned no row');
  return row;
}

export async function readCredential(
  client: PoolClient,
  organizationId: string,
  credentialId: string,
) {
  const [row] = await credentialRecords(client)
    .where(
      and(
        eq(authProvisioningCredentials.organizationId, organizationId),
        eq(authProvisioningCredentials.id, credentialId),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}

/** Revokes the credential once; false when the organization has no such credential. */
export async function markCredentialRevoked(
  client: PoolClient,
  organizationId: string,
  credentialId: string,
): Promise<boolean> {
  const result = await drizzle(client)
    .update(authProvisioningCredentials)
    .set({
      revokedAt: sql`coalesce(${authProvisioningCredentials.revokedAt},clock_timestamp())`,
    })
    .where(
      and(
        eq(authProvisioningCredentials.organizationId, organizationId),
        eq(authProvisioningCredentials.id, credentialId),
      ),
    )
    .returning({ id: authProvisioningCredentials.id })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}
