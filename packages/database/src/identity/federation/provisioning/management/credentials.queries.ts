import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { authProvisioningCredentials } from '../../../../schema/identity/federation/directory/credentials.js';
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
