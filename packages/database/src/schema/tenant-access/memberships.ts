import type { Role } from '@pertexo/policy';
import { sql } from 'drizzle-orm';
import {
  type PgTableExtraConfigValue,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { users } from '../identity/users.js';
import { workspaces } from './workspaces.js';

export const workspaceMemberships = appSchema.table(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: varchar('role', { length: 32 }).$type<Role>().notNull(),
    roleRevision: integer('role_revision').notNull().default(1),
    status: varchar('status', { length: 32 })
      .$type<'active' | 'suspended' | 'removed'>()
      .notNull()
      .default(sql`'active'::character varying`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workspace_memberships_role_revision_positive',
      sql`(role_revision > 0)`,
    ),
    check(
      'workspace_memberships_role_valid',
      sql`((role)::text = ANY (ARRAY[('owner'::character varying)::text, ('admin'::character varying)::text, ('builder'::character varying)::text, ('operator'::character varying)::text, ('viewer'::character varying)::text]))`,
    ),
    check(
      'workspace_memberships_status_valid',
      sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('removed'::character varying)::text]))`,
    ),
    primaryKey({
      name: 'workspace_memberships_pkey',
      columns: [table.workspaceId, table.userId],
    }),
    foreignKey({
      name: 'workspace_memberships_user_fk',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_memberships_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('restrict'),
    uniqueIndex('workspace_memberships_one_owner_unique')
      .on(table.workspaceId)
      .where(
        sql`(((role)::text = 'owner'::text) AND ((status)::text <> 'removed'::text))`,
      ),
    index('workspace_memberships_user_idx').on(table.userId, table.workspaceId),
    index('workspace_memberships_workspace_created_idx')
      .on(table.workspaceId, table.createdAt, table.userId)
      .where(
        sql`((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text]))`,
      ),
    index('workspace_memberships_workspace_status_idx').on(
      table.workspaceId,
      table.status,
      table.userId,
    ),
  ],
);
