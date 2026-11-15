import type { DirectoryUser } from '../directory-provisioning.types.js';

import type { Pool, PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import { withDirectoryTransaction } from '../directory-authority.js';

import { DirectoryError } from '../directory.errors.js';

import type {
  DirectoryPrincipal,
  DirectoryUserValues,
} from '../directory-provisioning.types.js';

import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';

import { projectDirectoryMemberships } from '../projection.repository.js';

import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';

import {
  countLiveDirectoryUsers,
  deleteDirectoryUserRow,
  findDirectoryUser,
  insertDirectoryUser,
  readUserGroupIds,
  updateDirectoryUser,
} from './users.repository.js';

export async function readDirectoryUser(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryUser> {
  const user = await findDirectoryUser(client, organizationId, id);
  if (user === undefined) throw new DirectoryError('not_found');
  const groups = await readUserGroupIds(client, organizationId, id);
  return { ...user, groupIds: groups };
}
export function createDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryUserValues,
): Promise<DirectoryUser> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client) => {
      const live = await countLiveDirectoryUsers(
        client,
        principal.organizationId,
      );
      if (live >= DIRECTORY_LIMITS.users) throw new DirectoryError('limit');
      const id = generatePersistedId();
      await insertDirectoryUser(client, principal.organizationId, {
        id,
        values,
      });
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_created',
        id,
      );
      return readDirectoryUser(client, principal.organizationId, id);
    }),
  );
}
/** PATCH transforms the current resource under the same lock as If-Match and persistence. */
export function changeDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  {
    id,
    expectedRevision,
    transform,
  }: Readonly<{
    id: string;
    expectedRevision: number | undefined;
    transform: (current: DirectoryUser) => DirectoryUserValues;
  }>,
): Promise<DirectoryUser> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const current = await readDirectoryUser(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(current.revision, expectedRevision);
      const values = transform(current);
      await updateDirectoryUser(client, principal.organizationId, {
        id,
        values,
      });
      if (current.user_id !== null)
        await projectDirectoryMemberships(
          client,
          organization,
          { credentialId: principal.credentialId },
          [current.id],
        );
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_changed',
        id,
      );
      return readDirectoryUser(client, principal.organizationId, id);
    }),
  );
}
export function deleteDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  id: string,
  expectedRevision: number | undefined,
): Promise<void> {
  return withDirectoryTransaction(
    pool,
    principal,
    async (client, organization) => {
      const user = await readDirectoryUser(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(user.revision, expectedRevision);
      await deleteDirectoryUserRow(client, principal.organizationId, id);
      if (user.user_id !== null)
        await projectDirectoryMemberships(
          client,
          organization,
          { credentialId: principal.credentialId },
          [user.id],
        );
      await directoryAudit(
        client,
        principal,
        'identity.directory_user_deleted',
        id,
      );
    },
  );
}
