import type { Pool, PoolClient } from 'pg';
import { generatePersistedId } from '../../../../platform/persisted-id.js';
import { withDirectoryTransaction } from '../authority.repository.js';
import {
  DirectoryError,
  type DirectoryPrincipal,
  type DirectoryUserRow,
  type DirectoryUserValues,
} from '../contract.js';
import { DIRECTORY_LIMITS } from '../limits.js';
import { projectDirectoryMemberships } from '../projection.repository.js';
import {
  assertDirectoryRevision,
  directoryAudit,
  withDirectoryConstraintErrors,
} from './shared.js';

export type DirectoryUser = DirectoryUserRow &
  Readonly<{ groupIds: readonly string[] }>;
export async function readDirectoryUser(
  client: PoolClient,
  organizationId: string,
  id: string,
): Promise<DirectoryUser> {
  const user = (
    await client.query<DirectoryUserRow>(
      'select * from app.auth_directory_users where organization_id=$1 and id=$2 and deleted_at is null',
      [organizationId, id],
    )
  ).rows[0];
  if (user === undefined) throw new DirectoryError('not_found');
  const groups = (
    await client.query<{ group_id: string }>(
      'select group_id from app.auth_directory_group_members where organization_id=$1 and directory_user_id=$2 order by group_id',
      [organizationId, id],
    )
  ).rows;
  return { ...user, groupIds: groups.map((group) => group.group_id) };
}
export function createDirectoryUser(
  pool: Pool,
  principal: DirectoryPrincipal,
  values: DirectoryUserValues,
): Promise<DirectoryUser> {
  return withDirectoryConstraintErrors(() =>
    withDirectoryTransaction(pool, principal, async (client) => {
      const count =
        (
          await client.query<{ count: number }>(
            'select count(*)::integer count from app.auth_directory_users where organization_id=$1',
            [principal.organizationId],
          )
        ).rows[0]?.count ?? 0;
      if (count >= DIRECTORY_LIMITS.users) throw new DirectoryError('limit');
      const id = generatePersistedId();
      await client.query(
        `insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,external_id,active,profile)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          id,
          principal.organizationId,
          values.userName,
          values.userName.toLowerCase(),
          values.profile.emails[0].value.toLowerCase(),
          values.externalId,
          values.active,
          JSON.stringify(values.profile),
        ],
      );
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
      await client.query(
        `update app.auth_directory_users set user_name=$3,normalized_user_name=$4,login_email=$5,external_id=$6,active=$7,profile=$8::jsonb,
      revision=revision+1,updated_at=clock_timestamp() where organization_id=$1 and id=$2`,
        [
          principal.organizationId,
          id,
          values.userName,
          values.userName.toLowerCase(),
          values.profile.emails[0].value.toLowerCase(),
          values.externalId,
          values.active,
          JSON.stringify(values.profile),
        ],
      );
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
      await client.query(
        'update app.auth_directory_users set active=false,deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where organization_id=$1 and id=$2',
        [principal.organizationId, id],
      );
      const groups = (
        await client.query<{ group_id: string }>(
          'delete from app.auth_directory_group_members where organization_id=$1 and directory_user_id=$2 returning group_id',
          [principal.organizationId, id],
        )
      ).rows;
      await client.query(
        'update app.auth_directory_groups set revision=revision+1,updated_at=clock_timestamp() where organization_id=$1 and id=any($2::uuid[])',
        [principal.organizationId, groups.map((group) => group.group_id)],
      );
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
