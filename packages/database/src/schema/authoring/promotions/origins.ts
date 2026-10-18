import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { appSchema } from '../../namespace.js';
import { workflows } from '../workflows.js';

export const workflowPromotionOrigins = appSchema.table(
  'workflow_promotion_origins',
  {
    workspaceId: uuid('workspace_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    sourceWorkspaceId: uuid('source_workspace_id').notNull(),
    sourceWorkflowId: uuid('source_workflow_id').notNull(),
    sourceVersionId: uuid('source_version_id').notNull(),
    sourceChecksum: varchar('source_checksum', { length: 82 }).notNull(),
    graphDigest: varchar('graph_digest', { length: 64 }).notNull(),
    targetName: varchar('target_name', { length: 128 }).notNull(),
    draftRevision: integer('draft_revision').notNull(),
    publishedVersionId: uuid('published_version_id'),
    promotionId: uuid('promotion_id').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.workflowId] }),
    foreignKey({
      name: 'promotion_origin_target_fk',
      columns: [table.workspaceId, table.workflowId],
      foreignColumns: [workflows.workspaceId, workflows.id],
    }).onDelete('cascade'),
    uniqueIndex('promotion_origin_source_unique').on(
      table.workspaceId,
      table.sourceWorkspaceId,
      table.sourceWorkflowId,
    ),
    check('promotion_origin_revision_positive', sql`draft_revision>0`),
    check(
      'promotion_origin_digests_valid',
      sql`source_checksum ~ '^wf:sha256:[a-f0-9]{64}$' and graph_digest ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'promotion_origin_name_valid',
      sql`length(btrim(target_name)) between 1 and 128`,
    ),
  ],
);
