import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { Client } from 'pg';

import { admin } from '../../lifecycle/calls/fixtures.js';
import { adminUrl, withDatabase } from '../../lifecycle/retention.support.js';

export const MODES = ['read', 'change'] as const;

export const anyMember = {
  capability: 'workspace:read',
  statuses: UNPURGED_WORKSPACE_STATUSES,
} as const;

export const RENAME = "update app.workspaces set name='Renamed' where id=$1";

export const workspaceName = async (workspaceId: string) =>
  (
    await admin.query<{ name: string }>(
      'select name from app.workspaces where id=$1',
      [workspaceId],
    )
  ).rows[0]?.name;

/** A connection of its own, which fails rather than waits on a held row. */
export async function withImpatientClient<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: withDatabase(adminUrl) });
  await client.connect();
  try {
    await client.query("set lock_timeout='3s'");
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function setStatus(workspaceId: string, status: string) {
  await admin.query(
    status === 'suspended' || status === 'active'
      ? 'update app.workspaces set status=$2 where id=$1'
      : `update app.workspaces set status=$2,deletion_requested_at=clock_timestamp(),deletion_requested_by=created_by,
         deletion_reason='Access test',purge_after=clock_timestamp()+interval '30 days' where id=$1`,
    [workspaceId, status],
  );
}
