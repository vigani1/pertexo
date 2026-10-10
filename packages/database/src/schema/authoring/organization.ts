import {
  type PgTableExtraConfigValue,
  bigint,
  check,
  foreignKey,
  index,
  primaryKey,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appSchema, textC } from '../app-schema.js';
import { workflows } from './workflows.js';
import { workspaces } from '../foundation.js';

export const workflowFolders = appSchema.table(
  'workflow_folders',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid().notNull(),
    parentId: uuid('parent_id'),
    name: textC('name').notNull(),
    nameKey: textC('name_key').notNull(),
    revision: bigint({ mode: 'number' }).default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_folders_check',
      sql`(name_key = translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'::text, 'abcdefghijklmnopqrstuvwxyz'::text))`,
    ),
    check('workflow_folders_check1', sql`(parent_id IS DISTINCT FROM id)`),
    check(
      'workflow_folders_name_check',
      sql`((name = btrim(name, ' '::text)) AND ((octet_length(name) >= 1) AND (octet_length(name) <= 128)) AND ((name COLLATE "C") !~ '[[:cntrl:]]'::text))`,
    ),
    check(
      'workflow_folders_revision_check',
      sql`((revision >= 1) AND (revision <= '9007199254740991'::bigint))`,
    ),
    primaryKey({
      name: 'workflow_folders_pkey',
      columns: [table.workspaceId, table.id],
    }),
    unique('workflow_folders_workspace_id_parent_id_name_key_key')
      .on(table.workspaceId, table.parentId, table.nameKey)
      .nullsNotDistinct(),
    foreignKey({
      name: 'workflow_folders_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }),
    foreignKey({
      name: 'workflow_folders_workspace_id_parent_id_fkey',
      columns: [table.workspaceId, table.parentId],
      foreignColumns: [table.workspaceId, table.id],
    }),
    index('workflow_folders_parent_idx').on(
      table.workspaceId,
      table.parentId,
      table.id,
    ),
  ],
);

export const workflowTags = appSchema.table(
  'workflow_tags',
  {
    workspaceId: uuid('workspace_id').notNull(),
    id: uuid().notNull(),
    key: textC('key').notNull(),
    revision: bigint({ mode: 'number' }).default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_tags_key_check',
      sql`((octet_length(key) >= 1) AND (octet_length(key) <= 32) AND ((key COLLATE "C") ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))`,
    ),
    check(
      'workflow_tags_revision_check',
      sql`((revision >= 1) AND (revision <= '9007199254740991'::bigint))`,
    ),
    primaryKey({
      name: 'workflow_tags_pkey',
      columns: [table.workspaceId, table.id],
    }),
    unique('workflow_tags_workspace_id_key_key').on(
      table.workspaceId,
      table.key,
    ),
    foreignKey({
      name: 'workflow_tags_workspace_id_fkey',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }),
  ],
);

export const workflowOrganizationState = appSchema.table(
  'workflow_organization_state',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    revision: bigint({ mode: 'number' }).default(1).notNull(),
    folderId: uuid('folder_id'),
  },
  (table): PgTableExtraConfigValue[] => [
    check(
      'workflow_organization_state_revision_check',
      sql`((revision >= 1) AND (revision <= '9007199254740991'::bigint))`,
    ),
    primaryKey({
      name: 'workflow_organization_state_pkey',
      columns: [table.workspaceId, table.workflowId],
    }),
    foreignKey({
      name: 'workflow_organization_state_folder_fk',
      columns: [table.workspaceId, table.folderId],
      foreignColumns: [workflowFolders.workspaceId, workflowFolders.id],
    }),
    foreignKey({
      name: 'workflow_organization_state_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    index('workflow_organization_state_folder_idx').on(
      table.workspaceId,
      table.folderId,
      table.workflowId,
    ),
  ],
);

export const workflowTagAssignments = appSchema.table(
  'workflow_tag_assignments',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'workflow_tag_assignments_pkey',
      columns: [table.workspaceId, table.workflowId, table.tagId],
    }),
    foreignKey({
      name: 'workflow_tag_assignments_workspace_id_tag_id_fkey',
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [workflowTags.workspaceId, workflowTags.id],
    }),
    foreignKey({
      name: 'workflow_tag_assignments_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    index('workflow_tag_assignments_tag_idx').on(
      table.workspaceId,
      table.tagId,
      table.workflowId,
    ),
  ],
);

export const workflowFavorites = appSchema.table(
  'workflow_favorites',
  {
    workspaceId: uuid('workspace_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'workflow_favorites_pkey',
      columns: [table.workspaceId, table.actorId, table.workflowId],
    }),
    foreignKey({
      name: 'workflow_favorites_workspace_id_workflow_id_fkey',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }),
    index('workflow_favorites_workflow_idx').on(
      table.workspaceId,
      table.workflowId,
      table.actorId,
    ),
  ],
);
