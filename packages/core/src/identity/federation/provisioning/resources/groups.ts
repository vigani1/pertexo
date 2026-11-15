import type { DirectoryGroup } from '../directory-provisioning.types.js';

import { removeDirectoryFolderGrants } from '../../../../memberships/resource-grants.repository.js';

import type { Pool, PoolClient } from 'pg';

import { generatePersistedId } from '@pertexo/database/platform';

import { withDirectoryTransaction } from '../directory-authority.js';

import { DirectoryError } from '../directory.errors.js';

import type {
  DirectoryPrincipal,
  DirectoryGroupValues,
} from '../directory-provisioning.types.js';

import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';

import { projectDirectoryMemberships } from '../projection.repository.js';

import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';

import {
  countDirectoryGroups,
  countLiveMembers,
  deleteDirectoryGroupRow,
  findDirectoryGroup,
  groupIsMapped,
  insertDirectoryGroup,
  readCurrentMemberIds,
  readGroupMemberIds,
  updateDirectoryGroup,
  writeGroupMembers,
} from './groups.repository.js';

export async function readDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryGroup> {
  const group = await findDirectoryGroup(client, organizationId, id);
  if (group === undefined) throw new DirectoryError('not_found');
  const members = await readGroupMemberIds(client, organizationId, id);
  return {
    ...group,
    memberIds: members,
  };
}
async function replaceMembers(
  client: PoolClient,
  organizationId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<readonly string[]> {
  const existing = await readCurrentMemberIds(client, organizationId, groupId);
  const valid = await countLiveMembers(client, organizationId, memberIds);
  if (valid !== memberIds.length) throw new DirectoryError('invalid_value');
  const before = new Set(existing),
    after = new Set(memberIds);
  const changed = [
    ...existing.filter((id) => !after.has(id)),
    ...memberIds.filter((id) => !before.has(id)),
  ];
  await writeGroupMembers(client, organizationId, groupId, {
    memberIds,
    changed,
  });
  return changed;
}
export function createDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryGroupValues,
): Promise<DirectoryGroup> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const groups = await countDirectoryGroups(
        client,
        principal.organizationId,
      );
      if (groups >= DIRECTORY_LIMITS.groups) throw new DirectoryError('limit');
      const id = generatePersistedId();
      await insertDirectoryGroup(client, principal.organizationId, {
        id,
        values,
      });
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        values.memberIds,
      );
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_created',
        id,
      );
      return readDirectoryGroup(client, principal.organizationId, id);
    }),
  );
}
export function changeDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  {
    id,
    expectedRevision,
    transform,
  }: Readonly<{
    id: string;
    expectedRevision: number | undefined;
    transform: (current: DirectoryGroup) => DirectoryGroupValues;
  }>,
): Promise<DirectoryGroup> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const current = await readDirectoryGroup(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(current.revision, expectedRevision);
      const values = transform(current);
      await updateDirectoryGroup(client, principal.organizationId, {
        id,
        values,
      });
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        values.memberIds,
      );
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_changed',
        id,
      );
      return readDirectoryGroup(client, principal.organizationId, id);
    }),
  );
}
export function deleteDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  id: string,
  expectedRevision: number | undefined,
): Promise<void> {
  return withDirectoryTransaction(
    pool,
    principal,
    async (client, organization) => {
      const group = await readDirectoryGroup(
        client,
        principal.organizationId,
        id,
      );
      assertDirectoryRevision(group.revision, expectedRevision);
      const mapped = await groupIsMapped(client, principal.organizationId, id);
      const affected = await replaceMembers(
        client,
        principal.organizationId,
        id,
        [],
      );
      await removeDirectoryFolderGrants(
        client,
        organization.id,
        organization.workspaces.map((workspace) => workspace.workspace_id),
        id,
      );
      await deleteDirectoryGroupRow(client, principal.organizationId, {
        id,
        mapped,
      });
      await projectDirectoryMemberships(
        client,
        organization,
        {
          credentialId: principal.credentialId,
        },
        affected,
      );
      await directoryAudit(
        client,
        principal,
        'identity.directory_group_deleted',
        id,
      );
    },
  );
}
