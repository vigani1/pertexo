import { publicCredential } from './credential-records.repository.js';

import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import type { DirectoryCredentialResult } from '@pertexo/contracts';

import { generatePersistedId } from '@pertexo/database/platform';

import { withWorkspaceAccess } from '../../../../shared/workspace-access.js';

import { organizationForWorkspace } from '../../management/authority.repository.js';

import { DirectoryError } from '../directory.errors.js';

import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';

import {
  auditDirectoryManagement,
  runDirectoryCommand,
} from './directory-commands.js';

import type {
  CreateCredentialInput,
  RevokeCredentialInput,
} from '../directory-provisioning.types.js';

import {
  countLiveCredentials,
  insertCredential,
  markCredentialRevoked,
  readCredential,
} from './credentials.repository.js';

const PROVISIONING_SECRET_BYTES = 32;

export async function createDirectoryCredential(
  pool: Pool,
  input: CreateCredentialInput,
): Promise<DirectoryCredentialResult> {
  const result = await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.credential.create',
    request: { name: input.name, expectedRevision: input.expectedRevision },
    change: async (client, organization) => {
      const live = await countLiveCredentials(client, organization.id);
      if (live >= DIRECTORY_LIMITS.credentials)
        throw new DirectoryError('limit');
      const id = generatePersistedId(),
        secret = randomBytes(PROVISIONING_SECRET_BYTES).toString('base64url');
      const row = await insertCredential(client, input, {
        id,
        organizationId: organization.id,
        secretDigest: createHash('sha256').update(secret).digest('hex'),
      });
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
  const { credentialId } = result.receipt;
  // Authority is rechecked after the receipt transaction, before projecting mutable metadata.
  const credential = await withWorkspaceAccess(
    pool,
    input,
    {
      mode: 'exclusive',
      capability: 'workspace:manage',
      statuses: ACTIVE_WORKSPACE_STATUSES,
    },
    async (client) => {
      const organization = await organizationForWorkspace(
        client,
        input.workspaceId,
      );
      if (organization?.control_workspace_id !== input.workspaceId)
        throw new DirectoryError('forbidden');
      const row = await readCredential(client, organization.id, credentialId);
      if (row === undefined) throw new DirectoryError('not_found');
      return publicCredential(row);
    },
  );
  return { replayed: true, credential };
}
export async function revokeDirectoryCredential(
  pool: Pool,
  input: RevokeCredentialInput,
): Promise<void> {
  await runDirectoryCommand(pool, input, {
    operation: 'identity.directory.credential.revoke',
    request: {
      credentialId: input.credentialId,
      expectedRevision: input.expectedRevision,
    },
    change: async (client, organization) => {
      const revoked = await markCredentialRevoked(
        client,
        organization.id,
        input.credentialId,
      );
      if (!revoked) throw new DirectoryError('not_found');
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
