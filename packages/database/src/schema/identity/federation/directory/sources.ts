import {
  foreignKey,
  index,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appSchema } from '../../../namespace.js';
import { workspaceMemberships } from '../../../foundation.js';
import { authOrganizationWorkspaces } from '../organizations.js';
import { authDirectoryUsers } from './users.js';
export const authDirectoryMemberships = appSchema.table(
  'auth_directory_memberships',
  {
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    directoryUserId: uuid('directory_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({
      name: 'auth_directory_memberships_pkey',
      columns: [t.workspaceId, t.userId],
    }),
    index('auth_directory_membership_user_idx').on(
      t.organizationId,
      t.directoryUserId,
    ),
    foreignKey({
      name: 'auth_directory_membership_member_fk',
      columns: [t.workspaceId, t.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_directory_membership_identity_fk',
      columns: [t.organizationId, t.directoryUserId, t.userId],
      foreignColumns: [
        authDirectoryUsers.organizationId,
        authDirectoryUsers.id,
        authDirectoryUsers.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'auth_directory_membership_workspace_fk',
      columns: [t.organizationId, t.workspaceId],
      foreignColumns: [
        authOrganizationWorkspaces.organizationId,
        authOrganizationWorkspaces.workspaceId,
      ],
    }).onDelete('restrict'),
  ],
);
