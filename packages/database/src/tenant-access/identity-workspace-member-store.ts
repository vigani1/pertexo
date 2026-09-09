import type { Pool } from 'pg';
import { z } from 'zod';

import { rolesForCapability } from './workspace-policy.js';
import { withTenantScopedClient } from './workspace.js';
import { parseIdentityUuid } from './identity-workspace-support.js';
import { WorkspaceAccessDeniedError } from './identity-workspace-errors.js';
import type {
  IdentityWorkspaceDatabase,
  MembershipRole,
  WorkspaceAccessRecord,
  WorkspaceMembersPage,
  WorkspaceStatus,
} from './identity-workspace.js';

type MemberStore = Pick<
  IdentityWorkspaceDatabase,
  'findWorkspaceAccess' | 'listWorkspaceMembers'
>;

const memberCursorTimestamp = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });

export function createIdentityWorkspaceMemberStore(pool: Pool): MemberStore {
  return Object.freeze({
    findWorkspaceAccess: async (
      actorIdInput: string,
      workspaceIdInput: string,
    ): Promise<WorkspaceAccessRecord | null> => {
      const actorId = parseIdentityUuid(actorIdInput);
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      return withTenantScopedClient(pool, { workspaceId }, async (client) => {
        const result = await client.query<{
          actor_id: string;
          workspace_id: string;
          role: MembershipRole;
          membership_status: 'active' | 'suspended' | 'removed';
          workspace_status: WorkspaceStatus;
        }>(
          `select m.user_id as actor_id, m.workspace_id,
                  m.role, m.status as membership_status,
                  w.status as workspace_status
           from app.workspace_memberships m
           join app.workspaces w on w.id = m.workspace_id
           join app.users u on u.id = m.user_id and u.status = 'active'
           where m.workspace_id = $1 and m.user_id = $2`,
          [workspaceId, actorId],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : Object.freeze({
              actorId: row.actor_id,
              workspaceId: row.workspace_id,
              role: row.role,
              membershipStatus: row.membership_status,
              workspaceStatus: row.workspace_status,
            });
      });
    },

    listWorkspaceMembers: async (
      workspaceIdInput: string,
      actorIdInput: string,
      input: Readonly<{
        limit?: number;
        after?: Readonly<{ createdAt: string; userId: string }>;
      }> = {},
    ): Promise<WorkspaceMembersPage> => {
      const workspaceId = parseIdentityUuid(workspaceIdInput);
      const actorId = parseIdentityUuid(actorIdInput);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError('Workspace member page limit is invalid');
      const afterUserId =
        input.after === undefined
          ? undefined
          : parseIdentityUuid(input.after.userId);
      const afterCreatedAt =
        input.after === undefined
          ? undefined
          : memberCursorTimestamp.parse(input.after.createdAt);
      return withTenantScopedClient(
        pool,
        { workspaceId, actorId },
        async (client): Promise<WorkspaceMembersPage> => {
          const actor = await client.query(
            `select 1
             from app.workspace_memberships m
             join app.users u on u.id = m.user_id and u.status = 'active'
             join app.workspaces w on w.id = m.workspace_id and w.status = 'active'
             where m.workspace_id = $1 and m.user_id = $2 and m.status = 'active'
               and m.role = any($3::text[])
             for share of m, u, w`,
            [workspaceId, actorId, [...rolesForCapability('member:read')]],
          );
          if (actor.rowCount !== 1)
            throw new WorkspaceAccessDeniedError(
              'Actor is no longer authorized for this workspace',
            );
          const result = await client.query<{
            user_id: string;
            email: string;
            display_name: string;
            role: MembershipRole;
            membership_status: 'active' | 'suspended';
            created_at: Date;
            updated_at: Date;
            created_at_cursor: string;
          }>(
            `select m.user_id, u.email, u.display_name,
                    m.role, m.status as membership_status,
                    m.created_at, m.updated_at,
                    to_char(m.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor
             from app.workspace_memberships m
             join app.users u on u.id = m.user_id and u.status = 'active'
             where m.workspace_id = $1
               and m.status in ('active', 'suspended')
               and ($2::timestamptz is null
                 or (m.created_at, m.user_id) > ($2::timestamptz, $3::uuid))
             order by m.created_at asc, m.user_id asc
             limit $4`,
            [
              workspaceId,
              afterCreatedAt ?? null,
              afterUserId ?? null,
              limit + 1,
            ],
          );
          const hasNext = result.rows.length > limit;
          const rows = hasNext ? result.rows.slice(0, limit) : result.rows;
          const last = rows[rows.length - 1];
          const items = Object.freeze(
            rows.map((row) =>
              Object.freeze({
                userId: row.user_id,
                email: row.email,
                displayName: row.display_name,
                role: row.role,
                membershipStatus: row.membership_status,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              }),
            ),
          );
          if (!hasNext) return Object.freeze({ items });
          if (last === undefined)
            throw new Error('Workspace member page cursor is unavailable');
          return Object.freeze({
            items,
            nextCursor: Object.freeze({
              createdAt: last.created_at_cursor,
              userId: last.user_id,
            }),
          });
        },
      );
    },
  });
}
