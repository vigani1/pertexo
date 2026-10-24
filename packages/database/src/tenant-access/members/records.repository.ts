import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workspaceMemberships } from '../../schema/foundation.js';
import { workflowFavorites } from '../../schema/authoring/organization.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import type { Role } from '@pertexo/workflow-model';
import { removeMemberResourceGrants } from '../resources/revocation.repository.js';
import type { PoolClient } from 'pg';

import { appendAuditFacts } from '../../governance/audit/events.repository.js';

export type MembershipAddition = Readonly<
  { userId: string; role: Role } & (
    | { source: 'workspace_creation' }
    | { source: 'invitation'; invitationId: string }
    | { source: 'jit'; organizationId: string }
    | {
        source: 'directory';
        organizationId: string;
        directoryUserId: string;
        credentialId?: string;
      }
  )
>;

type MembershipCreationAudit = Readonly<{
  actorId: string | null;
  requestId?: string | null;
  traceId?: string | null;
}>;

/** The caller owns admission and locks; insertion and its fact share that transaction. */
export async function createMemberships(
  client: PoolClient,
  workspaceId: string,
  additions: readonly MembershipAddition[],
  audit: MembershipCreationAudit,
): Promise<void> {
  const db = drizzle(client);
  const records = sql`unnest(${sql.param(additions.map((member) => member.userId))}::uuid[],
    ${sql.param(additions.map((member) => member.role))}::text[]) as member(user_id,role)`;
  await db
    .insert(workspaceMemberships)
    .select(
      db
        .select({
          workspaceId: sql<string>`${workspaceId}::uuid`.as('workspace_id'),
          userId: sql<string>`member.user_id`.as('user_id'),
          role: sql<Role>`member.role`.as('role'),
          roleRevision: sql<number>`1`.as('role_revision'),
          status: sql<'active'>`'active'`.as('status'),
          createdAt: sql<Date>`now()`.as('created_at'),
          updatedAt: sql<Date>`now()`.as('updated_at'),
        })
        .from(records),
    )
    .catch(rethrowQueryFailure);
  await appendAuditFacts(
    client,
    additions.map((member) => ({
      workspaceId,
      actorId: audit.actorId,
      requestId: audit.requestId ?? null,
      traceId: audit.traceId ?? null,
      action: 'workspace.member_added',
      targetType: 'workspace_member',
      targetId: member.userId,
      metadata: {
        role: member.role,
        source: member.source,
        status: 'active',
        roleRevision: 1,
        ...(member.source === 'invitation'
          ? { invitationId: member.invitationId }
          : {}),
        ...(member.source === 'jit' || member.source === 'directory'
          ? { organizationId: member.organizationId }
          : {}),
        ...(member.source === 'directory'
          ? {
              directoryUserId: member.directoryUserId,
              ...(member.credentialId === undefined
                ? {}
                : { credentialId: member.credentialId }),
            }
          : {}),
      },
    })),
  );
}

export type MembershipChange = Readonly<{
  userId: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
  roleRevision: number;
}>;

/** The caller owns unique member IDs and revisions; removal keeps private cleanup atomic. */
export async function updateMemberships(
  client: PoolClient,
  workspaceId: string,
  changes: readonly MembershipChange[],
): Promise<void> {
  if (changes.length === 0) return;
  const db = drizzle(client);
  const records = sql`unnest(${sql.param(changes.map((change) => change.userId))}::uuid[],
    ${sql.param(changes.map((change) => change.role))}::text[], ${sql.param(changes.map((change) => change.status))}::text[],
    ${sql.param(changes.map((change) => change.roleRevision))}::integer[]) as change(user_id,role,status,revision)`;
  await db
    .update(workspaceMemberships)
    .set({
      role: sql`change.role`,
      status: sql`change.status`,
      roleRevision: sql`change.revision`,
      updatedAt: sql`clock_timestamp()`,
    })
    .from(records)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, sql`change.user_id`),
      ),
    )
    .catch(rethrowQueryFailure);
  const removed = changes
    .filter((change) => change.status === 'removed')
    .map((change) => change.userId);
  if (removed.length === 0) return;
  // Private notice rows remain actor-fenced. This narrow storage bridge checks
  // removal and workspace scope instead of granting cross-user read/delete access.
  await db
    .execute(
      sql`select app.clear_removed_member_notices(${workspaceId},removed.user_id)
    from unnest(${sql.param(removed)}::uuid[]) as removed(user_id)`,
    )
    .catch(rethrowQueryFailure);
  await removeMemberResourceGrants(client, workspaceId, removed);
  await db
    .delete(workflowFavorites)
    .where(
      and(
        eq(workflowFavorites.workspaceId, workspaceId),
        sql`${workflowFavorites.actorId}=any(${sql.param(removed)}::uuid[])`,
      ),
    )
    .catch(rethrowQueryFailure);
}
export function updateMembership(
  client: PoolClient,
  workspaceId: string,
  change: MembershipChange,
): Promise<void> {
  return updateMemberships(client, workspaceId, [change]);
}
