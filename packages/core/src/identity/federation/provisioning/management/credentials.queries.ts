import type { DirectoryCredential } from '@pertexo/contracts';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { authProvisioningCredentials } from '@pertexo/database/schema';
export const credentialSelection = {
  id: authProvisioningCredentials.id,
  name: authProvisioningCredentials.name,
  created_at: authProvisioningCredentials.createdAt,
  revoked_at: authProvisioningCredentials.revokedAt,
  last_used_at: authProvisioningCredentials.lastUsedAt,
};
export function credentialRecords(client: PoolClient) {
  return drizzle(client)
    .select(credentialSelection)
    .from(authProvisioningCredentials);
}
export type CredentialRecord = Awaited<
  ReturnType<typeof credentialRecords>
>[number];

export const publicCredential = (
  row: CredentialRecord,
): DirectoryCredential => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});
