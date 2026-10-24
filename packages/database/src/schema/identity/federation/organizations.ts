import type { DelegatedRole } from '@pertexo/workflow-model';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workspaces } from '../../foundation.js';

export const authOrganizations = appSchema.table(
  'auth_organizations',
  {
    id: uuid().primaryKey(),
    controlWorkspaceId: uuid('control_workspace_id').notNull(),
    name: text().notNull(),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('auth_organization_control_unique').on(table.controlWorkspaceId),
    foreignKey({
      name: 'auth_organization_control_fk',
      columns: [table.controlWorkspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check(
      'auth_organization_name_valid',
      sql`length(btrim(name)) between 1 and 128`,
    ),
    check('auth_organization_revision_positive', sql`revision>0`),
  ],
);

export const authOrganizationWorkspaces = appSchema.table(
  'auth_organization_workspaces',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    defaultRole: text('default_role')
      .$type<DelegatedRole>()
      .notNull()
      .default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('auth_organization_workspace_org_idx').on(table.organizationId),
    unique('auth_organization_workspace_identity_unique').on(
      table.organizationId,
      table.workspaceId,
    ),
    foreignKey({
      name: 'auth_organization_workspace_org_fk',
      columns: [table.organizationId],
      foreignColumns: [authOrganizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'auth_organization_workspace_workspace_fk',
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete('cascade'),
    check(
      'auth_organization_workspace_role_valid',
      sql`default_role in ('viewer','builder','operator','admin')`,
    ),
  ],
);
