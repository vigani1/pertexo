import type { FormAccess } from '@pertexo/contracts';
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../namespace.js';
import { workflows } from '../authoring/workflows.js';
import { artifacts } from '../transport.js';

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

/**
 * A responder's file, bound to the form version or input request, field and
 * response session that began it. The file itself is an ordinary artifact.
 */
export const formUploads = appSchema.table(
  'form_uploads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    workflowVersionId: uuid('workflow_version_id'),
    taskId: uuid('task_id'),
    fieldId: varchar('field_id', { length: 64 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    sessionHash: char('session_hash', { length: 64 }).notNull(),
    capabilityHash: char('capability_hash', { length: 64 }),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.artifactId] }),
    foreignKey({
      name: 'form_uploads_artifact_fk',
      columns: [table.workspaceId, table.artifactId],
      foreignColumns: [artifacts.workspaceId, artifacts.id],
    }).onDelete('cascade'),
    check(
      'form_uploads_target_valid',
      sql`(workflow_version_id IS NULL) <> (task_id IS NULL)`,
    ),
    check(
      'form_uploads_responder_valid',
      sql`(capability_hash IS NULL) <> (uploaded_by IS NULL) AND (capability_hash IS NULL OR task_id IS NULL)`,
    ),
    check(
      'form_uploads_hashes_valid',
      sql`session_hash ~ '^[0-9a-f]{64}$' AND (capability_hash IS NULL OR capability_hash ~ '^[0-9a-f]{64}$')`,
    ),
    index('form_uploads_session_idx').on(table.workspaceId, table.sessionHash),
  ],
);
