import type { PoolClient } from 'pg';
import { detachDirectoryMemberships } from '../../identity/federation/provisioning/management/detach.js';

async function linkedWorkspaceIds(
  client: PoolClient,
  workspaceId: string,
): Promise<string[]> {
  return [
    ...new Set([
      workspaceId,
      ...(
        await client.query<{ workspace_id: string }>(
          `select workspace_id from app.auth_organization_workspaces where organization_id in
     (select organization_id from app.auth_organization_workspaces where workspace_id=$1)`,
          [workspaceId],
        )
      ).rows.map((row) => row.workspace_id),
    ]),
  ].sort();
}

/** Directory fan-out needs the same sorted workspace-first lock plan as sign-in. */
export async function claimPurgeWorkspace(
  client: PoolClient,
): Promise<Readonly<{ id: string; status: string }> | undefined> {
  const candidates = (
    await client.query<{ id: string }>(
      `select id from app.workspaces where (status='pending_deletion' and purge_after<=clock_timestamp()) or status='purging' order by purge_after,id limit 10`,
    )
  ).rows;
  for (const candidate of candidates) {
    const plan = await linkedWorkspaceIds(client, candidate.id);
    const locked = await client.query(
      'select id from app.workspaces where id=any($1::uuid[]) order by id for update skip locked',
      [plan],
    );
    if (locked.rowCount !== plan.length) continue;
    const current = await linkedWorkspaceIds(client, candidate.id);
    if (
      current.length !== plan.length ||
      current.some((id, index) => id !== plan[index])
    )
      continue;
    const row = (
      await client.query<{ id: string; status: string }>(
        `select id,status from app.workspaces where id=$1 and ((status='pending_deletion' and purge_after<=clock_timestamp()) or status='purging')`,
        [candidate.id],
      )
    ).rows[0];
    if (row !== undefined) return row;
  }
  return undefined;
}

/** One source page, including other workspaces if the control organization is being purged. */
export async function purgeDirectoryMemberships(
  client: PoolClient,
  workspaceId: string,
  limit: number,
): Promise<number> {
  const source = (
    await client.query<{ organization_id: string; workspace_id: string }>(
      `select source.organization_id,source.workspace_id from app.auth_directory_memberships source
     join app.auth_organizations organization on organization.id=source.organization_id
     where source.workspace_id=$1 or organization.control_workspace_id=$1
     order by source.workspace_id,source.user_id limit 1`,
      [workspaceId],
    )
  ).rows[0];
  if (source === undefined) return 0;
  await client.query("select set_config('app.workspace_id','',true)");
  const changed = await detachDirectoryMemberships(
    client,
    source.organization_id,
    { workspaceId: source.workspace_id, limit },
  );
  await client.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  return changed;
}
