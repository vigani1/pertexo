import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { connectionSecretVersions } from '@pertexo/database/schema';

import type { SealedConnectionSecretRecord } from '../contract.js';

/** Secret versions are only ever added: a new one replaces the current pointer. */
export async function insertSecretVersion(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    connectionId: string;
    secretVersionId: string;
    sealed: SealedConnectionSecretRecord;
    createdBy: string;
  }>,
): Promise<void> {
  const { sealed } = input;
  await drizzle(client)
    .insert(connectionSecretVersions)
    .values({
      id: input.secretVersionId,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      kmsKeyReference: sealed.kmsKeyReference,
      encryptedDataKey: sealed.encryptedDataKey,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      authTag: sealed.tag,
      createdBy: input.createdBy,
    })
    .catch(rethrowQueryFailure);
}
