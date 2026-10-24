import { removeDirectoryFolderGrants } from '../../../../tenant-access/resources/revocation.repository.js';
import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import { withDirectoryTransaction } from '../authority.js';
import {
  DirectoryError,
  type DirectoryPrincipal,
  type DirectoryGroupRow,
  type DirectoryGroupValues,
} from '../contract.js';
import { DIRECTORY_LIMITS } from '../limits.js';
import { projectDirectoryMemberships } from '../projection.js';
import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';

export type DirectoryGroup = DirectoryGroupRow &
  Readonly<{ memberIds: readonly string[] }>;
export async function readDirectoryGroup(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryGroup> {
  const group = (
    await client.query<DirectoryGroupRow>(
      'select * from app.auth_directory_groups where organization_id=$1 and id=$2',
      [organizationId, id],
    )
  ).rows[0];
  if (group === undefined) throw new DirectoryError('not_found');
  const members = (
    await client.query<{ directory_user_id: string }>(
      'select directory_user_id from app.auth_directory_group_members where organization_id=$1 and group_id=$2 order by directory_user_id',
      [organizationId, id],
    )
  ).rows;
  return {
    ...group,
    memberIds: members.map((member) => member.directory_user_id),
  };
}
async function replaceMembers(
  client: PoolClient,
  organizationId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<readonly string[]> {
  const existing = (
    await client.query<{ directory_user_id: string }>(
      'select directory_user_id from app.auth_directory_group_members where organization_id=$1 and group_id=$2',
      [organizationId, groupId],
    )
  ).rows.map((member) => member.directory_user_id);
  const valid = (
    await client.query(
      'select id from app.auth_directory_users where organization_id=$1 and id=any($2::uuid[]) and deleted_at is null',
      [organizationId, memberIds],
    )
  ).rowCount;
  if (valid !== memberIds.length) throw new DirectoryError('invalid_value');
  const before = new Set(existing),
    after = new Set(memberIds);
  const changed = [
    ...existing.filter((id) => !after.has(id)),
    ...memberIds.filter((id) => !before.has(id)),
  ];
  await client.query(
    'delete from app.auth_directory_group_members where organization_id=$1 and group_id=$2',
    [organizationId, groupId],
  );
  if (memberIds.length > 0)
    await client.query(
      `insert into app.auth_directory_group_members(organization_id,group_id,directory_user_id) select $1,$2,unnest($3::uuid[])`,
      [organizationId, groupId, memberIds],
    );
  await client.query(
    'update app.auth_directory_users set revision=revision+1,updated_at=clock_timestamp() where organization_id=$1 and id=any($2::uuid[])',
    [organizationId, changed],
  );
  return changed;
}
export function createDirectoryGroup(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryGroupValues,
): Promise<DirectoryGroup> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client, organization) => {
      const count =
        (
          await client.query<{ count: number }>(
            'select count(*)::integer count from app.auth_directory_groups where organization_id=$1',
            [principal.organizationId],
          )
        ).rows[0]?.count ?? 0;
      if (count >= DIRECTORY_LIMITS.groups) throw new DirectoryError('limit');
      const id = generatePersistedId();
      await client.query(
        'insert into app.auth_directory_groups(id,organization_id,display_name,external_id) values($1,$2,$3,$4)',
        [id, principal.organizationId, values.displayName, values.externalId],
      );
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
      await client.query(
        'update app.auth_directory_groups set display_name=$3,external_id=$4,revision=revision+1,updated_at=clock_timestamp() where organization_id=$1 and id=$2',
        [principal.organizationId, id, values.displayName, values.externalId],
      );
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
      const mapped =
        (
          await client.query(
            'select 1 from app.auth_directory_group_mappings where organization_id=$1 and group_id=$2 limit 1',
            [principal.organizationId, id],
          )
        ).rowCount !== 0;
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
      await client.query(
        'delete from app.auth_directory_groups where organization_id=$1 and id=$2',
        [principal.organizationId, id],
      );
      if (mapped)
        await client.query(
          'update app.auth_organizations set revision=revision+1 where id=$1',
          [principal.organizationId],
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
        'identity.directory_group_deleted',
        id,
      );
    },
  );
}
