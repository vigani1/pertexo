import type { FormAccess } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  integer,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';

export const workflowForms = appSchema.table(
  'workflow_forms',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    publicId: uuid('public_id').notNull(),
    nodeId: varchar('node_id', { length: 128 }).notNull(),
    access: varchar({ length: 16 })
      .$type<FormAccess['access']>()
      .notNull()
      .default('members'),
    capabilityHash: char('capability_hash', { length: 64 }),
    revision: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    unique('workflow_forms_public_id_unique').on(table.publicId),
    foreignKey({
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    check('workflow_forms_revision_positive', sql`revision>0`),
    check(
      'workflow_forms_access_valid',
      sql`((access='members' AND capability_hash IS NULL) OR (access='public' AND capability_hash ~ '^[0-9a-f]{64}$')) IS TRUE`,
    ),
  ],
);
