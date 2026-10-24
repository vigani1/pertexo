import type { DelegatedRole } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../../namespace.js';
import { authOrganizationWorkspaces } from '../organizations.js';
import { authDirectoryGroups } from './groups.js';
export const authDirectoryGroupMappings = appSchema.table(
  'auth_directory_group_mappings',
  {
    organizationId: uuid('organization_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    groupId: uuid('group_id').notNull(),
    role: text().$type<DelegatedRole>().notNull(),
    priority: integer().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'auth_directory_group_mappings_pkey',
      columns: [t.organizationId, t.workspaceId, t.groupId],
    }),
    unique('auth_directory_group_mapping_priority_unique').on(
      t.organizationId,
      t.workspaceId,
      t.priority,
    ),
    foreignKey({
      name: 'auth_directory_group_mapping_group_fk',
      columns: [t.organizationId, t.groupId],
      foreignColumns: [
        authDirectoryGroups.organizationId,
        authDirectoryGroups.id,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_directory_group_mapping_workspace_fk',
      columns: [t.organizationId, t.workspaceId],
      foreignColumns: [
        authOrganizationWorkspaces.organizationId,
        authOrganizationWorkspaces.workspaceId,
      ],
    }).onDelete('cascade'),
    check(
      'auth_directory_group_mapping_role_valid',
      sql`role in ('viewer','operator','builder','admin')`,
    ),
    check(
      'auth_directory_group_mapping_priority_valid',
      sql`priority between 0 and 199`,
    ),
  ],
);
