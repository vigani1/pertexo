import { isIntegerInRange } from '../../platform/persisted-primitives.js';
import type { Role } from '@pertexo/workflow-model';
import type { Pool } from 'pg';
import { z } from 'zod';

import { rolesForCapability } from '@pertexo/workflow-model';
import {
  withActorScopedClient,
  withTenantScopedClient,
} from '../transactions.js';
import { parseIdentityUuid } from '../support.js';
import { lockWorkspaceAuthority } from '../workspaces/authority.queries.js';
import type {
  IdentityWorkspaceDatabase,
  AccessibleWorkspacesPage,
  WorkspaceAccessRecord,
  WorkspaceMembersPage,
  WorkspaceStatus,
} from '../contract.js';

type MemberStore = Pick<
  IdentityWorkspaceDatabase,
  'findWorkspaceAccess' | 'listAccessibleWorkspaces' | 'listWorkspaceMembers'
>;

const memberCursorTimestamp = z.iso
  .datetime({ precision: 6 })
  .refine((value) => !value.startsWith('0000-'), {
    message: 'PostgreSQL timestamps do not support year zero',
  });

async function listAccessibleWorkspaces(
  pool: Pool,
  actorIdInput: string,
  input: Readonly<{ limit?: number; after?: string }> = {},
): Promise<AccessibleWorkspacesPage> {
  const actorId = parseIdentityUuid(actorIdInput);
  const after =
    input.after === undefined ? undefined : parseIdentityUuid(input.after);
  const limit = input.limit ?? 50;
  const invalidLimit = !isIntegerInRange(limit, 1, 100);
  if (invalidLimit)
    throw new RangeError('Accessible workspace page limit is invalid');
  return withActorScopedClient(pool, actorId, async (client) => {
    const result = await client.query<{
      id: string;
      name: string;
      slug: string;
      status: Extract<
        WorkspaceStatus,
        'active' | 'suspended' | 'pending_deletion'
      >;
      role: Role;
      revision: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `select w.id, w.name, w.slug, w.status, w.revision, m.role,
              w.created_at, w.updated_at
       from app.workspace_memberships m
       join app.workspaces w on w.id = m.workspace_id
       join app.users u on u.id = m.user_id and u.status = 'active'
       where m.user_id = $1 and m.status = 'active'
         and w.status in ('active', 'suspended', 'pending_deletion')
         and ($2::uuid is null or w.id > $2::uuid)
       order by w.id asc
       limit $3`,
      [actorId, after ?? null, limit + 1],
    );
    const hasNext = result.rows.length > limit;
    const rows = hasNext ? result.rows.slice(0, limit) : result.rows;
    const items = Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          revision: row.revision,
          role: row.role,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      ),
    );
    const last = rows.at(-1);
    return Object.freeze({
      items,
      ...(hasNext && last !== undefined ? { nextCursor: last.id } : {}),
    });
  });
}

async function findWorkspaceAccess(
  pool: Pool,
  actorIdInput: string,
  workspaceIdInput: string,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<WorkspaceAccessRecord | null> {
  const actorId = parseIdentityUuid(actorIdInput);
  const workspaceId = parseIdentityUuid(workspaceIdInput);
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const result = await client.query<{
        actor_id: string;
        workspace_id: string;
        role: Role;
        role_revision: number;
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
    },
    options,
  );
}

async function listWorkspaceMembers(
  pool: Pool,
  workspaceIdInput: string,
  actorIdInput: string,
  input: Readonly<{
    limit?: number;
    after?: Readonly<{ createdAt: string; userId: string }>;
  }> = {},
): Promise<WorkspaceMembersPage> {
  const workspaceId = parseIdentityUuid(workspaceIdInput);
  const actorId = parseIdentityUuid(actorIdInput);
  const limit = input.limit ?? 50;
  const invalidLimit = !isIntegerInRange(limit, 1, 100);
  if (invalidLimit)
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
      await lockWorkspaceAuthority(
        client,
        workspaceId,
        actorId,
        rolesForCapability('member:read'),
      );
      const result = await client.query<
        (
          | {
              directory_user_id: null;
              directory_organization_id: null;
              directory_revision: null;
              directory_control_workspace_id: null;
            }
          | {
              directory_user_id: string;
              directory_organization_id: string;
              directory_revision: number;
              directory_control_workspace_id: string;
            }
        ) & {
          user_id: string;
          email: string;
          display_name: string;
          role: Role;
          role_revision: number;
          membership_status: 'active' | 'suspended';
          created_at: Date;
          updated_at: Date;
          created_at_cursor: string;
        }
      >(
        `select m.user_id, u.email, u.display_name,
                source.directory_user_id,source.organization_id directory_organization_id,
                directory.revision directory_revision,organization.control_workspace_id directory_control_workspace_id,
                m.role, m.role_revision, m.status as membership_status,
                m.created_at, m.updated_at,
                to_char(m.created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor
         from app.workspace_memberships m
         join app.users u on u.id = m.user_id and u.status = 'active'
         left join app.auth_directory_memberships source on source.workspace_id=m.workspace_id and source.user_id=m.user_id
         left join app.auth_directory_users directory on directory.id=source.directory_user_id
         left join app.auth_organizations organization on organization.id=source.organization_id
         where m.workspace_id = $1
           and m.status in ('active', 'suspended')
           and ($2::timestamptz is null
             or (m.created_at, m.user_id) > ($2::timestamptz, $3::uuid))
         order by m.created_at asc, m.user_id asc
         limit $4`,
        [workspaceId, afterCreatedAt ?? null, afterUserId ?? null, limit + 1],
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
            roleRevision: row.role_revision,
            membershipStatus: row.membership_status,
            ...(row.directory_user_id === null
              ? {}
              : {
                  directorySource: {
                    directoryUserId: row.directory_user_id,
                    organizationId: row.directory_organization_id,
                    directoryRevision: row.directory_revision,
                    controlWorkspaceId: row.directory_control_workspace_id,
                  },
                }),
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
}

export function createIdentityWorkspaceMemberStore(pool: Pool): MemberStore {
  return Object.freeze({
    listAccessibleWorkspaces: (actorId, input) =>
      listAccessibleWorkspaces(pool, actorId, input),
    findWorkspaceAccess: (actorId, workspaceId, options) =>
      findWorkspaceAccess(pool, actorId, workspaceId, options),
    listWorkspaceMembers: (workspaceId, actorId, input) =>
      listWorkspaceMembers(pool, workspaceId, actorId, input),
  });
}
