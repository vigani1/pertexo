import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  DirectoryCredential,
  DirectoryCredentialResult,
} from '@pertexo/contracts';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import { withPlatformTransaction } from '../../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../../tenant-access/workspaces/authority.queries.js';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import { organizationForWorkspace } from '../../management/authority.js';
import { DirectoryError } from '../contract.js';
import { DIRECTORY_LIMITS } from '../limits.js';
import {
  auditDirectoryManagement,
  runDirectoryCommand,
  type DirectoryCommand,
} from './commands.js';

export type CredentialRow = Readonly<{
  id: string;
  name: string;
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}>;
export const publicCredential = (row: CredentialRow): DirectoryCredential => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});
const credentialReceipt = z.object({ credentialId: z.uuid() }).strict();
export async function createDirectoryCredential(
  pool: Pool,
  input: DirectoryCommand & Readonly<{ name: string }>,
): Promise<DirectoryCredentialResult> {
  const result = await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.credential.create',
    request: { name: input.name, expectedRevision: input.expectedRevision },
    change: async (client, organization) => {
      const count =
        (
          await client.query<{ count: number }>(
            'select count(*)::integer count from app.auth_provisioning_credentials where organization_id=$1 and revoked_at is null',
            [organization.id],
          )
        ).rows[0]?.count ?? 0;
      if (count >= DIRECTORY_LIMITS.credentials)
        throw new DirectoryError('limit');
      const id = generatePersistedId(),
        secret = randomBytes(32).toString('base64url');
      const row = (
        await client.query<CredentialRow>(
          `insert into app.auth_provisioning_credentials(id,organization_id,name,secret_digest,created_by)
      values($1,$2,$3,$4,$5) returning id,name,created_at,revoked_at,last_used_at`,
          [
            id,
            organization.id,
            input.name,
            createHash('sha256').update(secret).digest('hex'),
            input.actorId,
          ],
        )
      ).rows[0];
      if (row === undefined)
        throw new Error('Credential creation returned no row');
      await auditDirectoryManagement(client, input, {
        organizationId: organization.id,
        action: 'identity.directory_credential_created',
        targetId: id,
      });
      return {
        receipt: { credentialId: id },
        value: { credential: publicCredential(row), secret },
      };
    },
  });
  if (!result.replayed) return { replayed: false, ...result.value };
  const { credentialId } = credentialReceipt.parse(result.receipt);
  const credential = await withPlatformTransaction(pool, async (client) => {
    // Authority is rechecked after the receipt transaction, before projecting mutable metadata.
    await client.query('select id from app.workspaces where id=$1 for update', [
      input.workspaceId,
    ]);
    await withWorkspaceScope(client, input, (scoped) =>
      lockWorkspaceAuthority(scoped, input.workspaceId, input.actorId, [
        'owner',
      ]),
    );
    const organization = await organizationForWorkspace(
      client,
      input.workspaceId,
    );
    if (organization?.control_workspace_id !== input.workspaceId)
      throw new DirectoryError('forbidden');
    const row = (
      await client.query<CredentialRow>(
        'select id,name,created_at,revoked_at,last_used_at from app.auth_provisioning_credentials where organization_id=$1 and id=$2',
        [organization.id, credentialId],
      )
    ).rows[0];
    if (row === undefined) throw new DirectoryError('not_found');
    return publicCredential(row);
  });
  return { replayed: true, credential };
}
export async function revokeDirectoryCredential(
  pool: Pool,
  input: DirectoryCommand & Readonly<{ credentialId: string }>,
): Promise<void> {
  await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.credential.revoke',
    request: {
      credentialId: input.credentialId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client, organization) => {
      const result = await client.query(
        'update app.auth_provisioning_credentials set revoked_at=coalesce(revoked_at,clock_timestamp()) where organization_id=$1 and id=$2 returning id',
        [organization.id, input.credentialId],
      );
      if (result.rowCount !== 1) throw new DirectoryError('not_found');
      await auditDirectoryManagement(client, input, {
        organizationId: organization.id,
        action: 'identity.directory_credential_revoked',
        targetId: input.credentialId,
      });
      return {
        receipt: { credentialId: input.credentialId },
        value: undefined,
      };
    },
  });
}
