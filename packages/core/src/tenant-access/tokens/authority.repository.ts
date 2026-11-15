import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  users,
  workspaces,
  workspaceMemberships,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';

import type { ApiTokenOwner } from './api-token.types.js';

/** The token owner's workspace, user and membership standing, locked unless reading. */
export async function readTokenOwnerStanding(
  client: PoolClient,
  input: ApiTokenOwner,
  mode: 'read' | 'create' | 'revoke',
) {
  const db = drizzle(client);
  const workspaceQuery = db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId));
  const workspace = await (
    mode === 'read' ? workspaceQuery : workspaceQuery.for('update')
  ).catch(rethrowQueryFailure);
  const userQuery = db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, input.ownerUserId));
  const user = await (
    mode === 'read' ? userQuery : userQuery.for('update')
  ).catch(rethrowQueryFailure);
  const memberQuery = db
    .select({
      role: workspaceMemberships.role,
      status: workspaceMemberships.status,
      roleRevision: workspaceMemberships.roleRevision,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.ownerUserId),
      ),
    );
  const member = await (
    mode === 'read' ? memberQuery : memberQuery.for('update')
  ).catch(rethrowQueryFailure);
  return {
    workspaceStatus: workspace[0]?.status,
    userStatus: user[0]?.status,
    membership: member[0],
  };
}
