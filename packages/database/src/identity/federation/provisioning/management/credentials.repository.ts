import { credentialReceipt } from './receipt.js';
import { publicCredential } from './credentials.queries.js';
import { authProvisioningCredentials } from '../../../../schema/identity/federation/directory/credentials.js';
import { workspaces } from '../../../../schema/foundation.js';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  credentialRecords,
  credentialSelection,
} from './credentials.queries.js';
import { rethrowQueryFailure } from '../../../../platform/query-errors.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

import type { DirectoryCredentialResult } from '@pertexo/contracts';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import { withPlatformTransaction } from '../../../../tenant-access/transactions.js';
import { lockWorkspaceAuthority } from '../../../../tenant-access/workspaces/authority.queries.js';
import { withWorkspaceScope } from '../../../../tenant-access/transactions.js';
import { organizationForWorkspace } from '../../management/authority.repository.js';
import { DirectoryError } from '../errors.js';
import { DIRECTORY_LIMITS } from '../limits.js';
import {
  auditDirectoryManagement,
  runDirectoryCommand,
} from './commands.repository.js';
import type { DirectoryCommand } from '../contract.js';

export async function createDirectoryCredential(
  pool: Pool,
  input: DirectoryCommand & Readonly<{ name: string }>,
): Promise<DirectoryCredentialResult> {
  const result = await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.credential.create',
    request: { name: input.name, expectedRevision: input.expectedRevision },
    change: async (client, organization) => {
      const [countRow] = await drizzle(client)
        .select({ count: count() })
        .from(authProvisioningCredentials)
        .where(
          and(
            eq(authProvisioningCredentials.organizationId, organization.id),
            isNull(authProvisioningCredentials.revokedAt),
          ),
        )
        .catch(rethrowQueryFailure);
      if ((countRow?.count ?? 0) >= DIRECTORY_LIMITS.credentials)
        throw new DirectoryError('limit');
      const id = generatePersistedId(),
        secret = randomBytes(32).toString('base64url');
      const [row] = await drizzle(client)
        .insert(authProvisioningCredentials)
        .values({
          id,
          organizationId: organization.id,
          name: input.name,
          secretDigest: createHash('sha256').update(secret).digest('hex'),
          createdBy: input.actorId,
        })
        .returning(credentialSelection)
        .catch(rethrowQueryFailure);
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
    await drizzle(client)
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .for('update')
      .catch(rethrowQueryFailure);
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
    const [row] = await credentialRecords(client)
      .where(
        and(
          eq(authProvisioningCredentials.organizationId, organization.id),
          eq(authProvisioningCredentials.id, credentialId),
        ),
      )
      .catch(rethrowQueryFailure);
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
      const result = await drizzle(client)
        .update(authProvisioningCredentials)
        .set({
          revokedAt: sql`coalesce(${authProvisioningCredentials.revokedAt},clock_timestamp())`,
        })
        .where(
          and(
            eq(authProvisioningCredentials.organizationId, organization.id),
            eq(authProvisioningCredentials.id, input.credentialId),
          ),
        )
        .returning({ id: authProvisioningCredentials.id })
        .catch(rethrowQueryFailure);
      if (result.length !== 1) throw new DirectoryError('not_found');
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
