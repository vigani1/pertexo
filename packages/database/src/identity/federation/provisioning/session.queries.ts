import type { PoolClient } from 'pg';

export async function directorySessionAllowed(
  client: PoolClient,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = (
    await client.query<{ active: boolean; deleted_at: Date | null }>(
      `select active,deleted_at from app.auth_directory_users where organization_id=$1 and user_id=$2
     order by (deleted_at is null) desc,created_at desc,id desc limit 1`,
      [organizationId, userId],
    )
  ).rows;
  const current = rows[0];
  return (
    current === undefined || (current.active && current.deleted_at === null)
  );
}
