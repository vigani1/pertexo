import type { FolderAccess } from '../stored-shapes.js';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workspaceMemberships } from '../foundation.js';
import { workflowFolders } from './organization.js';
import { authDirectoryGroups } from '../identity/federation/directory/groups.js';
import { authOrganizationWorkspaces } from '../identity/federation/organizations.js';

export const workflowFolderGrants = appSchema.table(
  'workflow_folder_grants',
  {
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    userId: uuid('user_id'),
    organizationId: uuid('organization_id'),
    groupId: uuid('group_id'),
    access: varchar({ length: 16 }).$type<FolderAccess>().notNull(),
  },
  (table) => [
    check(
      'workflow_folder_grants_access_valid',
      sql`access in ('viewer','editor')`,
    ),
    check(
      'workflow_folder_grants_principal_valid',
      sql`(user_id is not null and organization_id is null and group_id is null) or (user_id is null and organization_id is not null and group_id is not null)`,
    ),
    unique('workflow_folder_grants_member_unique').on(
      table.workspaceId,
      table.folderId,
      table.userId,
    ),
    unique('workflow_folder_grants_group_unique').on(
      table.workspaceId,
      table.folderId,
      table.organizationId,
      table.groupId,
    ),
    index('workflow_folder_grants_member_idx').on(
      table.workspaceId,
      table.userId,
      table.folderId,
    ),
    index('workflow_folder_grants_group_idx').on(
      table.workspaceId,
      table.organizationId,
      table.groupId,
      table.folderId,
    ),
    foreignKey({
      name: 'workflow_folder_grants_folder_fk',
      columns: [table.workspaceId, table.folderId],
      foreignColumns: [workflowFolders.workspaceId, workflowFolders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_folder_grants_member_fk',
      columns: [table.workspaceId, table.userId],
      foreignColumns: [
        workspaceMemberships.workspaceId,
        workspaceMemberships.userId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_folder_grants_group_fk',
      columns: [table.organizationId, table.groupId],
      foreignColumns: [
        authDirectoryGroups.organizationId,
        authDirectoryGroups.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'workflow_folder_grants_link_fk',
      columns: [table.organizationId, table.workspaceId],
      foreignColumns: [
        authOrganizationWorkspaces.organizationId,
        authOrganizationWorkspaces.workspaceId,
      ],
    }).onDelete('cascade'),
  ],
);
