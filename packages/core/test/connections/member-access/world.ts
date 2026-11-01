import type { PoolClient } from 'pg';
import { beforeAll, expect } from 'vitest';
import type { Role } from '@pertexo/workflow-model';

import {
  ConnectionNotFoundError,
  Pool,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  randomUUID,
  registerCurrentConnectionsFixture,
  workspaceA,
} from '../../support/connections.js';
import { insertTestMember } from '../../support/user.js';

export const connections = registerCurrentConnectionsFixture();

/** Written out rather than read from the policy, so a changed grant fails here. */
export const ROLE_MEMBERS: Readonly<Record<Role, string>> = {
  owner: ownerA,
  admin: randomUUID(),
  builder: randomUUID(),
  operator: randomUUID(),
  viewer: randomUUID(),
};

/** An active user with no membership anywhere. */
export const stranger = randomUUID();

export async function asDatabaseOwner<T>(
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: databaseUrl(migrationBaseUrl),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function existingConnection(
  overrides: Parameters<typeof createInput>[0] = {},
): Promise<ReturnType<typeof createInput>> {
  const input = createInput(overrides);
  await connections.api.createConnection(input);
  return input;
}

export function newMember(role: Role, label = 'Member'): Promise<string> {
  const userId = randomUUID();
  return asDatabaseOwner(workspaceA, async (client) => {
    await insertTestMember(client.query.bind(client), {
      userId,
      workspaceId: workspaceA,
      displayName: `${label} ${role}`,
      role,
    });
    return userId;
  });
}

export function setMembership(
  userId: string,
  change: Readonly<{ status: 'removed' | 'suspended' } | { role: Role }>,
): Promise<void> {
  return asDatabaseOwner(workspaceA, async (client) => {
    await client.query(
      `update app.workspace_memberships
       set status=coalesce($3,status), role=coalesce($4,role)
       where workspace_id=$1 and user_id=$2`,
      [
        workspaceA,
        userId,
        'status' in change ? change.status : null,
        'role' in change ? change.role : null,
      ],
    );
  });
}

export function suspendUser(userId: string): Promise<void> {
  return asDatabaseOwner(workspaceA, async (client) => {
    await client.query(`update app.users set status='suspended' where id=$1`, [
      userId,
    ]);
  });
}

type WorkspaceStatus = 'active' | 'suspended' | 'pending_deletion';

export function setWorkspaceStatusStatement(
  client: PoolClient,
  status: WorkspaceStatus,
) {
  const deleting = status === 'pending_deletion';
  return client.query(
    `update app.workspaces set status=$2,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'connection access proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1`,
    [workspaceA, status, deleting],
  );
}

/** Runs `work` with the workspace in `status`, and always puts it back. */
export async function whileWorkspaceIs<T>(
  status: WorkspaceStatus,
  work: () => Promise<T>,
): Promise<T> {
  await asDatabaseOwner(workspaceA, (client) =>
    setWorkspaceStatusStatement(client, status),
  );
  try {
    return await work();
  } finally {
    await asDatabaseOwner(workspaceA, (client) =>
      setWorkspaceStatusStatement(client, 'active'),
    );
  }
}

/** Only administrators, the creator and `userIds` can reach it from here on. */
export async function restrictConnection(
  connectionId: string,
  userIds: readonly string[],
): Promise<void> {
  const { revision } = await connections.api.readConnectionSharing({
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
  });
  await connections.api.replaceConnectionSharing({
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
    idempotencyKey: `restrict-${randomUUID()}`,
    request: {
      mode: 'restricted',
      userIds: [...userIds],
      expectedSharingRevision: revision,
    },
  });
}

/** The one answer anyone without access gets, whatever the reason. */
export async function expectNotVisible(attempt: Promise<unknown>) {
  const failure: unknown = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ConnectionNotFoundError);
  expect((failure as Error).message).toBe('Connection is not visible');
}

export function registerMembers(): void {
  beforeAll(async () => {
    await asDatabaseOwner(workspaceA, async (client) => {
      for (const [role, userId] of Object.entries(ROLE_MEMBERS)) {
        if (role === 'owner') continue;
        await insertTestMember(client.query.bind(client), {
          userId,
          workspaceId: workspaceA,
          displayName: `Connection ${role}`,
          role: role as Role,
        });
      }
      await client.query(
        `insert into app.users (id,email,display_name,status)
         values ($1,$2,'Stranger','active')`,
        [stranger, `${stranger}@example.test`],
      );
    });
  });
}
